import { test, expect, type Locator, type Page } from "./fixtures";
import {
  findSegmentFarFromAirports,
  gotoApp,
  knownYears,
  openWrapped,
  readSavedState,
  settleAnimations,
  toastMessage,
  togglePathSelection,
  waitForAircraftFilter,
  waitForAppReady,
  waitForWrappedMap,
  waitForYearFilter,
} from "./helpers";
import {
  containerPoint,
  getCenter,
  getZoom,
  mapPopup,
  segmentDetails,
  setView,
  waitForMapReady,
  wheelZoomIn,
} from "./map";
import { unpackShareToken } from "../../flown/frontend/state/shareToken";
import { SHARE_TOKEN_PARAM } from "../../flown/frontend/state/urlState";

/** Fail loudly if the cards no longer overflow, rather than time out */
async function expectScrollable(column: Locator): Promise<void> {
  const overflow = await column.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  expect(overflow, "the cards column has nothing to scroll").toBeGreaterThan(0);
}

test.describe("Wrapped and Export", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("wrapped button opens wrapped modal", async ({ page }) => {
    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeHidden();

    await openWrapped(page);
    await expect(wrappedModal).toHaveAttribute("role", "dialog");
    await expect(wrappedModal).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#wrapped-content")).toBeVisible();
  });

  // The mobile project does not run this file: below the breakpoint the
  // cards stack above the map and the dialog scrolls as one column, which
  // mobile.spec.ts covers
  test("the map stays put while the cards scroll", async ({ page }) => {
    await openWrapped(page);
    const column = page.locator("#wrapped-cards-column");
    const map = page.locator("#wrapped-map-container");
    await expect(map).toBeVisible();

    await settleAnimations(map);
    await expectScrollable(column);

    const before = await map.boundingBox();
    await column.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect
      .poll(() => column.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    const after = await map.boundingBox();

    // Scrolling the row itself used to take the map with it and leave most
    // of the dialog empty for every card after the first
    expect(after?.y).toBe(before?.y);
    await expect(map).toBeInViewport();
  });

  test("the overview map of the dialog still zooms", async ({ page }) => {
    const modal = await openWrapped(page);
    await expect(modal.locator("#wrapped-map-container #map")).toBeVisible();
    await waitForWrappedMap(page);
    await waitForMapReady(page);
    const before = await getZoom(page);

    // The markers are inert while the dialog is open; the map itself must
    // not be, or the overview could neither be panned nor zoomed
    await wheelZoomIn(page);

    await expect.poll(() => getZoom(page)).toBeGreaterThan(before);
  });

  test("a click on the overview map leaves the selection alone (regression)", async ({
    page,
  }) => {
    // Sets the altitude layer up and finds a flight that no marker covers
    const flight = await findSegmentFarFromAirports(page, {
      includePathId: true,
    });
    expect(flight).not.toBeNull();
    const selectedId = await page.evaluate(
      (other) => window.mapApp!.fullPathInfo!.find((p) => p.id !== other)!.id,
      flight!.pathId!,
    );
    await togglePathSelection(page, selectedId, 1);
    const selection = (): Promise<number[]> =>
      page.evaluate(() => [...window.mapApp!.selectedPathIds]);

    const modal = await openWrapped(page);
    await waitForWrappedMap(page);
    await waitForMapReady(page);

    // The overview takes gestures so it can be moved, and with them came
    // the clicks: one beside the flights cleared the selection behind the
    // dialog, one on a flight toggled it, and both were saved
    const map = page.locator("#wrapped-map-container #map");
    // Clear of the rounded corner, which belongs to the dialog
    await map.click({ position: { x: 40, y: 40 } });
    const at = await containerPoint(page, [
      flight!.coord[0]!,
      flight!.coord[1]!,
    ]);
    await map.click({ position: at });
    await map.hover({ position: at });
    // The hover answers in the next frame
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );

    expect(await selection()).toEqual([selectedId]);
    // Neither the values of a tapped flight nor a hover tooltip: the first
    // has a close button that would be a tab stop outside the dialog
    await expect(mapPopup(page)).toHaveCount(0);
    await expect(segmentDetails(page)).toHaveCount(0);

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden();
    // The close is saved; what it writes is the selection of before
    await expect
      .poll(async () => (await readSavedState(page))["wrappedVisible"])
      .toBe(false);
    expect((await readSavedState(page))["selectedPathIds"]).toEqual([
      selectedId,
    ]);
    expect(await selection()).toEqual([selectedId]);
  });

  test("reopening starts at the top of the cards", async ({ page }) => {
    const modal = page.locator("#wrapped-modal");
    const column = page.locator("#wrapped-cards-column");

    await openWrapped(page);
    await expectScrollable(column);
    await column.evaluate((el) => el.scrollTo(0, 900));
    await expect
      .poll(() => column.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden();
    await openWrapped(page);

    // The column keeps its position between openings, so without a reset
    // Wrapped reopens halfway down a card instead of on the title
    await expect.poll(() => column.evaluate((el) => el.scrollTop)).toBe(0);
  });

  test("wrapped modal closes via close button", async ({ page }) => {
    const wrappedModal = page.locator("#wrapped-modal");

    await openWrapped(page);

    await wrappedModal.locator(".close-btn").click();
    await expect(wrappedModal).toBeHidden();
  });

  test("wrapped modal traps focus and returns it on close", async ({
    page,
  }) => {
    const wrappedBtn = page.locator("#wrapped-btn");
    await wrappedBtn.focus();
    await wrappedBtn.press("Enter");

    const wrappedModal = page.locator("#wrapped-modal");
    await expect(wrappedModal).toBeVisible({ timeout: 5000 });
    await expect(wrappedModal.locator(".close-btn")).toBeFocused();
    await expect(page.locator("#left-buttons")).toHaveAttribute("inert", "");
    await expect(page.locator("#right-buttons")).toHaveAttribute("inert", "");
    await expect(page.locator("#github-footer")).toHaveAttribute("inert", "");

    await page.keyboard.press("Escape");

    await expect(wrappedModal).toBeHidden();
    await expect(page.locator("#left-buttons")).not.toHaveAttribute(
      "inert",
      "",
    );
    await expect(wrappedBtn).toBeFocused();
  });

  test("wrapped modal shows content sections", async ({ page }) => {
    await openWrapped(page);

    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-title")).toBeVisible();
    await expect(page.locator("#wrapped-year")).toBeVisible();
    await expect(page.locator("#wrapped-stats")).toBeAttached();
  });

  test("wrapped modal shows all content cards", async ({ page }) => {
    await openWrapped(page);

    await expect(page.locator("#wrapped-card-stats")).toBeVisible();
    await expect(page.locator("#wrapped-card-facts")).toBeVisible();
    await expect(page.locator("#wrapped-card-fleet")).toBeVisible();
    await expect(page.locator("#wrapped-card-airports")).toBeVisible();
  });

  test("wrapped destinations are grouped by country", async ({ page }) => {
    await openWrapped(page);

    const airportsCard = page.locator("#wrapped-card-airports");
    await expect(airportsCard).toBeVisible();

    const countryGroups = airportsCard.locator(".country-group");
    expect(await countryGroups.count()).toBeGreaterThanOrEqual(1);

    const firstTitle = airportsCard.locator(".country-group-title").first();
    await expect(firstTitle).toBeVisible();
    await expect(firstTitle).not.toHaveText(/^\s*$/);
  });

  test("wrapped stats card contains flight data", async ({ page }) => {
    await openWrapped(page);

    const statsCard = page.locator("#wrapped-card-stats");
    await expect(statsCard).toContainText("Flights");
    await expect(statsCard).toContainText("Airports");
  });

  test("wrapped modal includes map container", async ({ page }) => {
    await openWrapped(page);

    await expect(page.locator("#wrapped-map-container #map")).toBeAttached();
  });

  test("wrapped modal close button is accessible", async ({ page }) => {
    const modal = await openWrapped(page);

    const closeBtn = modal.locator(".close-btn");
    await expect(closeBtn).toBeVisible();
    await expect(closeBtn).toHaveAttribute("aria-label", "Close Wrapped");
    await closeBtn.click();
    await expect(modal).toBeHidden();

    await openWrapped(page);
  });

  test("map returns to original position after closing wrapped", async ({
    page,
  }) => {
    await openWrapped(page);

    await page.locator("#wrapped-modal .close-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeHidden();

    const mapEl = page.locator("#map");
    await expect(mapEl).toBeVisible();
    await waitForMapReady(page);
    await expect(page.locator("#wrapped-map-container #map")).toHaveCount(0);
  });

  test("a reload with the dialog open keeps the user's view (regression)", async ({
    page,
  }) => {
    await setView(page, [48.1, 11.6], 13);
    const view = { center: await getCenter(page), zoom: await getZoom(page) };
    await expect
      .poll(async () => (await readSavedState(page))["zoom"])
      .toBe(view.zoom);

    await openWrapped(page);

    // The fitted overview is on the map, but the saved view is the user's:
    // saved as it was, a reload reopened the dialog over the overview and
    // closing it landed there
    await expect
      .poll(async () => (await readSavedState(page))["wrappedVisible"])
      .toBe(true);
    const saved = (await readSavedState(page)) as {
      center: { lat: number; lng: number };
      zoom: number;
    };
    expect(saved.zoom).toBe(view.zoom);
    // Close rather than equal: the view has to come back, not its last digits
    expect(saved.center.lat).toBeCloseTo(view.center.lat, 3);
    expect(saved.center.lng).toBeCloseTo(view.center.lng, 3);

    await page.reload();
    await waitForAppReady(page);
    const modal = page.locator("#wrapped-modal");
    await expect(modal).toBeVisible({ timeout: 5000 });
    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden();

    await expect.poll(() => getZoom(page)).toBe(view.zoom);
    const after = await getCenter(page);
    expect(after.lat).toBeCloseTo(view.center.lat, 3);
    expect(after.lng).toBeCloseTo(view.center.lng, 3);
  });

  test("wrapped panel updates when year filter changes", async ({ page }) => {
    const years = await knownYears(page);
    const yearSelect = page.locator("#year-select");
    await expect(yearSelect.locator("option")).toHaveCount(years.length + 1);

    const year = years[0]!;
    await yearSelect.selectOption(year);
    await waitForYearFilter(page, year);

    await openWrapped(page);

    await expect(page.locator("#wrapped-year")).toHaveText(year);
    await expect(page.locator("#wrapped-title")).toHaveText(
      "Your Year in Flight",
    );
  });

  test("wrapped panel updates when aircraft filter changes", async ({
    page,
  }) => {
    const aircraftSelect = page.locator("#aircraft-select");
    const options = aircraftSelect.locator("option");
    expect(await options.count()).toBeGreaterThanOrEqual(2);
    const aircraftOption = (await options.nth(1).getAttribute("value"))!;

    await openWrapped(page);

    const allStatsText = await page.locator("#wrapped-stats").textContent();
    await page.locator("#wrapped-modal .close-btn").click();
    await expect(page.locator("#wrapped-modal")).toBeHidden();

    await aircraftSelect.selectOption(aircraftOption);
    await waitForAircraftFilter(page, aircraftOption);

    await openWrapped(page);

    await expect(page.locator("#wrapped-stats")).not.toHaveText(allStatsText!);
    await expect(page.locator("#wrapped-aircraft-fleet")).toContainText(
      aircraftOption,
    );
  });

  test("wrapped panel shows all years when year filter set to all", async ({
    page,
  }) => {
    await page.locator("#year-select").selectOption("all");
    await waitForYearFilter(page, "all");

    await openWrapped(page);

    await expect(page.locator("#wrapped-year")).toHaveText("All years");
    await expect(page.locator("#wrapped-title")).toHaveText(
      "Your Flight History",
    );
  });

  /**
   * Stand in for html-to-image, for reliable headless testing: the page
   * imports the vendored module on the first export, and gets this instead
   */
  const FAKE_HTML_TO_IMAGE =
    "export const toJpeg = () => Promise.resolve(" +
    '"data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA");';

  async function fakeHtmlToImage(page: Page): Promise<void> {
    await page.route("**/vendor/html-to-image.mjs*", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: FAKE_HTML_TO_IMAGE,
      }),
    );
  }

  test("export button triggers download", async ({ page }) => {
    await fakeHtmlToImage(page);

    const downloadPromise = page.waitForEvent("download", {
      timeout: 10000,
    });
    await page.locator("#export-btn").click();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^flown_.*\.jpg$/);

    await expect(toastMessage(page, "Map exported")).toBeVisible();
    await expect(page.locator("#export-btn")).toHaveText("Export image");
    await expect(page.locator("#export-btn")).toBeEnabled();
    await expect(page.locator("#replay-btn")).toBeVisible();
  });

  test("export imports html-to-image on demand, reports when it is unavailable and tries again", async ({
    page,
  }) => {
    // The library is not part of the initial page load
    const requested: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("html-to-image"))
        requested.push(request.url());
    });
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("html-to-image")),
      ),
    ).toBe(false);

    await page.route("**/html-to-image*", (route) => route.abort());
    await page.locator("#export-btn").click();

    await expect(
      toastMessage(
        page,
        "Export is unavailable: its code could not be loaded. Check the connection and try again.",
      ),
    ).toBeVisible();
    await expect(page.locator("#export-btn")).toHaveText("Export image");
    await expect(page.locator("#export-btn")).toBeEnabled();
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/\/vendor\/html-to-image\.mjs$/);

    // A browser may answer the import of a URL that failed from memory, so
    // the next export asks for the module under another one
    await page.unroute("**/html-to-image*");
    await fakeHtmlToImage(page);
    const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
    await page.locator("#export-btn").click();

    await downloadPromise;
    expect(requested).toHaveLength(2);
    expect(requested[1]).toMatch(/\/vendor\/html-to-image\.mjs\?retry=1$/);
  });

  test("the vendored html-to-image is a module with the export the page uses", async ({
    page,
  }) => {
    const exportsToJpeg = await page.evaluate(async () => {
      const library = (await import(
        new URL("./vendor/html-to-image.mjs", location.href).href
      )) as { toJpeg?: unknown };
      return typeof library.toJpeg;
    });

    expect(exportsToJpeg).toBe("function");
  });

  test("share button copies a short link to the current view", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.locator("#share-btn").click();

    // With the token, whether the code that packs it had come or the
    // clipboard was handed the link to come (UIToggles.shareLink), which
    // waits for that code: a busy runner may take seconds to fetch it
    await expect(toastMessage(page, "Link copied")).toBeVisible({
      timeout: 20_000,
    });
    const copied = new URL(
      await page.evaluate(() => navigator.clipboard.readText()),
    );
    const current = new URL(page.url());
    expect(copied.origin + copied.pathname).toBe(
      current.origin + current.pathname,
    );
    expect([...copied.searchParams.keys()]).toEqual([SHARE_TOKEN_PARAM]);
    // The token resolves to the link in the address bar
    const resolved = unpackShareToken(
      copied.searchParams.get(SHARE_TOKEN_PARAM)!,
    );
    expect(resolved?.toString()).toBe(current.searchParams.toString());
  });
});
