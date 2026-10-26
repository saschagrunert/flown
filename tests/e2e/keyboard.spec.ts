/**
 * The map and its dialogs worked by keyboard alone.
 *
 * A keyboard cannot click a path, and a click on a path used to be the only
 * way to select a single flight, so replay was out of its reach. These specs
 * walk the airport popup, the replay timeline and the year in review the way
 * a keyboard user does.
 */
import { test, expect, type Page } from "./fixtures";
import {
  activateReplay,
  gotoApp,
  openWrapped,
  waitForAppReady,
  waitForPathData,
} from "./helpers";
import {
  airportMarkerIsFocused,
  centerOnAirport,
  expectMarkersInert,
  focusAirportMarker,
  mapPopup,
  openAirportPopup,
} from "./map";

/**
 * Centre the map on the airport with the most flights and focus its marker.
 * Returns the airport and how many flights it lists.
 */
async function focusBusiestAirport(
  page: Page,
): Promise<{ name: string; flights: number }> {
  await waitForPathData(page);
  const airport = await page.evaluate(() => {
    const [name, ids] = Object.entries(window.mapApp!.airportToPaths).sort(
      (a, b) => b[1].size - a[1].size,
    )[0]!;
    return { name, flights: ids.size };
  });
  await centerOnAirport(page, airport.name, 10);
  await focusAirportMarker(page, airport.name);
  return airport;
}

test.describe("Keyboard", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("an airport popup lists its flights and selects a single one", async ({
    page,
  }) => {
    const airport = await focusBusiestAirport(page);
    await page.keyboard.press("Enter");

    // Opened from the keyboard, the popup takes focus
    const popup = mapPopup(page);
    await expect(popup).toBeVisible();
    await expect(popup.locator(".popup-airport")).toBeFocused();

    const flights = popup.locator(".popup-flight");
    await expect(flights).toHaveCount(airport.flights);
    // Route, aircraft and year; never a date or a time of day
    for (const label of await flights.allTextContents()) {
      expect(label).toMatch(/→/);
      expect(label).not.toMatch(/\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/);
    }

    // Enter on the marker selected every flight of the airport, which
    // replay plays one after another up to a day of them (DAY_MAX_FLIGHTS)
    await expect(flights.first()).toHaveAttribute("aria-pressed", "true");
    const many = airport.flights > 8;
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "aria-disabled",
      String(many),
    );
    if (many) {
      await expect(page.locator("#replay-btn")).toHaveAttribute(
        "title",
        "Select up to 8 flights to replay them one after another; Replay all plays more",
      );
    }

    await flights.first().focus();
    await page.keyboard.press("Enter");

    await expect
      .poll(() => page.evaluate(() => window.mapApp!.selectedPathIds.size))
      .toBe(1);
    await expect(
      popup.locator('.popup-flight[aria-pressed="true"]'),
    ).toHaveCount(1);
    // Exactly one flight: replay is now within reach
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "aria-disabled",
      "false",
    );

    // Escape from inside the popup closes it and focus goes back to the
    // marker instead of the page
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    expect(await airportMarkerIsFocused(page, airport.name)).toBe(true);
  });

  test("an airport popup names the runways its flights used", async ({
    page,
  }) => {
    await focusBusiestAirport(page);
    await page.keyboard.press("Enter");

    const popup = mapPopup(page);
    await expect(popup).toContainText("Runways");
    await expect(popup).toContainText(/RWY \d{2}[LCR]? · \d+%/);
  });

  test("Escape on a focused marker closes its popup", async ({ page }) => {
    const airport = await focusBusiestAirport(page);
    await openAirportPopup(page, airport.name);
    await expect(mapPopup(page)).toBeVisible();

    await focusAirportMarker(page, airport.name);
    await page.keyboard.press("Escape");

    await expect(mapPopup(page)).toHaveCount(0);
    expect(await airportMarkerIsFocused(page, airport.name)).toBe(true);
  });

  test("Escape on a marker with no popup closes what the page has open", async ({
    page,
  }) => {
    const airport = await focusBusiestAirport(page);
    await page.locator("#local-flights-btn").click();
    const panel = page.locator("#local-flights");
    await expect(panel).toBeVisible();

    await focusAirportMarker(page, airport.name);
    await page.keyboard.press("Escape");

    await expect(panel).toBeHidden();
    await expect(mapPopup(page)).toHaveCount(0);
  });

  test("a popup opened with the mouse leaves focus alone", async ({ page }) => {
    await focusBusiestAirport(page);
    const marker = await page.evaluate(() => {
      const box = (
        document.activeElement as HTMLElement
      ).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(marker.x, marker.y);

    await expect(page.locator(".popup-flight").first()).toBeVisible();
    await expect(page.locator(".popup-airport")).not.toBeFocused();
  });

  test("Share mode says it is unavailable without a selection", async ({
    page,
  }) => {
    const isolate = page.locator("#isolate-btn");
    await expect(isolate).toHaveAttribute("aria-disabled", "true");
    // Still focusable, unlike a disabled button
    await isolate.focus();
    await expect(isolate).toBeFocused();

    await focusBusiestAirport(page);
    await page.keyboard.press("Enter");
    await expect(isolate).toHaveAttribute("aria-disabled", "false");
  });

  test("an arrow key moves the replay a hundredth of the flight", async ({
    page,
  }) => {
    await activateReplay(page);
    const slider = page.locator("#replay-slider");
    const max = Number(await slider.getAttribute("max"));
    const step = Math.max(1, Math.round(max / 100));
    const page10 = Math.max(1, Math.round(max / 10));

    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect(slider).toHaveValue(String(step));
    await page.keyboard.press("PageUp");
    await expect(slider).toHaveValue(String(step + page10));
    await page.keyboard.press("ArrowLeft");
    await expect(slider).toHaveValue(String(page10));
    await expect(slider).toHaveAttribute("aria-valuetext", /^\d.* of \d/);

    // Never past either end
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await expect(slider).toHaveValue("0");
  });

  test("Clear on the selection chip hands focus to the map", async ({
    page,
  }) => {
    await focusBusiestAirport(page);
    await page.keyboard.press("Enter");
    const chip = page.locator("#selection-chip");
    await expect(chip).toBeVisible();

    await page.locator("#selection-clear-btn").focus();
    await page.keyboard.press("Enter");

    // The chip hides with the selection; focus went to the map rather than
    // falling to <body> with it
    await expect(chip).toBeHidden();
    await expect(page.locator("#map .maplibregl-canvas")).toBeFocused();
  });

  test("the airport markers leave the tab order while Wrapped is open", async ({
    page,
  }) => {
    await waitForPathData(page);
    const modal = await openWrapped(page);
    await expect(modal.locator("#map")).toBeAttached();

    await expectMarkersInert(page, true);

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expectMarkersInert(page, false);
    await expect(page.locator("#wrapped-btn")).toBeFocused();
  });
});

test.describe("Keyboard, Wrapped from a link", () => {
  test("closing it puts focus on the control that opens it", async ({
    page,
  }) => {
    // The seventh visibility flag restores the dialog
    await page.goto("/?v=000000100");
    await waitForAppReady(page);
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("Escape");

    await expect(modal).toBeHidden();
    await expect(page.locator("#wrapped-btn")).toBeFocused();
  });
});
