import { test, expect } from "./fixtures";
import {
  gotoApp,
  knownYears,
  selectPathForReplay,
  togglePathSelection,
  waitForAircraftFilter,
  waitForStatsContent,
  waitForYearFilter,
} from "./helpers";

test.describe("Filters and Statistics", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("year filter dropdown lists all known years", async ({ page }) => {
    await expect(page.locator("#year-filter")).toBeVisible();

    const yearSelect = page.locator("#year-select");
    await expect(yearSelect).toBeVisible();

    const values = await yearSelect
      .locator("option")
      .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));
    expect(values).toEqual(["all", ...(await knownYears(page))]);
  });

  test("aircraft filter dropdown has options", async ({ page }) => {
    await expect(page.locator("#aircraft-filter")).toBeVisible();

    const aircraftSelect = page.locator("#aircraft-select");
    await expect(aircraftSelect).toBeVisible();
    expect(
      await aircraftSelect.locator("option").count(),
    ).toBeGreaterThanOrEqual(2);
  });

  test("year filter changes data", async ({ page }) => {
    const yearSelect = page.locator("#year-select");
    const year = (await knownYears(page))[0]!;

    await yearSelect.selectOption(year);
    await waitForYearFilter(page, year);

    await expect(yearSelect).toHaveValue(year);
    const years = await page.evaluate(() =>
      Array.from(
        new Set(window.mapApp!.currentData!.path_info.map((p) => p.year)),
      ),
    );
    expect(years).toEqual([Number(year)]);
  });

  test("aircraft filter has options and can be changed", async ({ page }) => {
    const aircraftSelect = page.locator("#aircraft-select");
    const options = aircraftSelect.locator("option");
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    const secondOption = (await options.nth(1).getAttribute("value"))!;
    await aircraftSelect.selectOption(secondOption);
    await waitForAircraftFilter(page, secondOption);

    await expect(aircraftSelect).toHaveValue(secondOption);
  });

  test("statistics panel opens and closes", async ({ page }) => {
    const statsBtn = page.locator("#stats-btn");
    const statsPanel = page.locator("#stats-panel");

    await expect(statsPanel).toBeHidden();

    await statsBtn.click();
    await expect(statsPanel).toBeVisible();

    await statsBtn.click();
    await expect(statsPanel).toBeHidden();
  });

  test("statistics open as a rail and the left column slides past it", async ({
    page,
  }) => {
    const rail = page.locator("#stats-rail");
    const column = page.locator("#left-buttons");
    const collapse = page.locator("#stats-collapse-btn");

    await expect(rail).toHaveAttribute("hidden", "");
    const closedLeft = (await column.boundingBox())!.x;

    await page.locator("#stats-btn").click();

    await expect(rail).not.toHaveAttribute("hidden", "");
    await expect(page.locator("body")).toHaveClass(/stats-open/);
    // The controls keep their labels and their size, they only move over
    await expect(page.locator("#stats-btn .control-label")).toBeVisible();
    await expect(page.locator("#stats-btn svg.icon")).toHaveAttribute(
      "width",
      "16",
    );
    // Poll until the slide transition has finished
    await expect
      .poll(async () => {
        const rBox = await rail.boundingBox();
        const cBox = await column.boundingBox();
        return rBox && cBox ? cBox.x >= rBox.x + rBox.width : false;
      })
      .toBe(true);

    // The rail carries its own way back
    await collapse.click();

    await expect(rail).toHaveAttribute("hidden", "");
    await expect(page.locator("#stats-btn svg.icon")).toHaveAttribute(
      "width",
      "16",
    );
    await expect
      .poll(async () => {
        const box = await column.boundingBox();
        return box ? Math.round(box.x) : -1;
      })
      .toBe(Math.round(closedLeft));
  });

  test("statistics panel does not cover the left button column", async ({
    page,
  }) => {
    await page.locator("#stats-btn").click();
    const panel = page.locator("#stats-panel");
    await expect(panel).toBeVisible();

    // Poll until the slide transition has finished
    await expect
      .poll(async () => {
        const pBox = await panel.boundingBox();
        const sBtn = await page.locator("#stats-btn").boundingBox();
        return pBox && sBtn
          ? sBtn.x >= pBox.x + pBox.width || sBtn.x + sBtn.width <= pBox.x
          : false;
      })
      .toBe(true);

    const panelBox = (await panel.boundingBox())!;
    for (const selector of ["#stats-btn", "#export-btn", "#replay-btn"]) {
      const box = (await page.locator(selector).boundingBox())!;
      const overlaps =
        box.x < panelBox.x + panelBox.width &&
        box.x + box.width > panelBox.x &&
        box.y < panelBox.y + panelBox.height &&
        box.y + box.height > panelBox.y;
      expect(overlaps, `${selector} is covered by the stats panel`).toBe(false);
    }
  });

  test("stats panel shows flight statistics with expected fields", async ({
    page,
  }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    const panel = await waitForStatsContent(page);

    await expect(page.locator("#stats-rail-title")).toHaveText("Statistics");
    // The count decides the plural, so match the shape rather than a literal,
    // grouped by thousands as the rail writes it. Matched on the element: the
    // panel's text runs straight on into the build line below it.
    await expect(panel.locator(".stats-footer")).toHaveText(
      /^\d{1,3}(,\d{3})* data points?$/,
    );
    // The commit is left out where the build could not tell which one it was
    await expect(panel.locator(".stats-build")).toHaveText(
      /^Built \d{1,2} [A-Z][a-z]{2} \d{4}( from [0-9a-f]{7})?$/,
    );
    await expect(panel).toContainText("Flights");
    await expect(panel).toContainText("Distance");
    await expect(panel).toContainText("nm");
  });

  test("stats panel counts the landings", async ({ page }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    const panel = await waitForStatsContent(page);

    // The build reads them from the logs, which all have timestamps
    await expect(panel).toContainText("Full-stop landings");
    await expect(panel).toContainText("Touch-and-goes");
    await expect(panel).toContainText("Go-arounds");
  });

  test("stats panel shows airports and aircraft", async ({ page }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    const panel = await waitForStatsContent(page);

    await expect(panel).toContainText("Airports");
    await expect(panel).toContainText("Aircraft");
    await expect(panel).toContainText(/\d+ flights?/);
  });

  test("stats update for selected path", async ({ page }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    const panel = await waitForStatsContent(page);

    const globalText = await panel.textContent();

    await selectPathForReplay(page);

    await expect(page.locator("#stats-rail-title")).toContainText(
      "Statistics of the selection",
    );
    // Exactly one path is selected, and the readout counts it in words
    await expect(panel).toContainText(/1 selected flights?/);
    expect(await panel.textContent()).not.toBe(globalText);
  });

  test("stats revert to global after deselecting all paths", async ({
    page,
  }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    await waitForStatsContent(page);

    const pathId = await selectPathForReplay(page);
    const title = page.locator("#stats-rail-title");
    await expect(title).toContainText("Statistics of the selection");

    await togglePathSelection(page, pathId, 0);

    await expect(title).toHaveText("Statistics");
  });

  test("year filter updates stats panel content", async ({ page }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    const panel = await waitForStatsContent(page);

    const yearSelect = page.locator("#year-select");
    await yearSelect.selectOption("all");
    await waitForYearFilter(page, "all");
    const allText = await panel.textContent();

    const year = (await knownYears(page))[0]!;
    await yearSelect.selectOption(year);
    await waitForYearFilter(page, year);

    await expect.poll(() => panel.textContent()).not.toBe(allText);
  });

  test("aircraft filter updates stats and can be reset", async ({ page }) => {
    await page.locator("#stats-btn").click();
    // Its figures, not the loading line of the first opening
    const panel = await waitForStatsContent(page);

    const allText = await panel.textContent();

    const aircraftSelect = page.locator("#aircraft-select");
    const options = aircraftSelect.locator("option");
    expect(await options.count()).toBeGreaterThanOrEqual(2);

    const aircraftOption = (await options.nth(1).getAttribute("value"))!;
    await aircraftSelect.selectOption(aircraftOption);
    await waitForAircraftFilter(page, aircraftOption);

    await expect.poll(() => panel.textContent()).not.toBe(allText);
    await expect(panel).toContainText(aircraftOption);

    await aircraftSelect.selectOption("all");
    await waitForAircraftFilter(page, "all");
    await expect(page.locator("#stats-rail-title")).toHaveText("Statistics");
    await expect.poll(() => panel.textContent()).toBe(allText);
  });

  test("year filter updates aircraft filter options", async ({ page }) => {
    const aircraftSelect = page.locator("#aircraft-select");
    const yearSelect = page.locator("#year-select");

    await yearSelect.selectOption("all");
    await waitForYearFilter(page, "all");
    const allYearsOptions = await aircraftSelect.locator("option").count();

    const year = (await knownYears(page))[0]!;
    await yearSelect.selectOption(year);
    await waitForYearFilter(page, year);

    const registrations = await page.evaluate(
      () =>
        new Set(
          window.mapApp!.currentData!.path_info.map(
            (p) => p.aircraft_registration,
          ),
        ).size,
    );
    // "all" plus one option per aircraft flown in that year
    await expect(aircraftSelect.locator("option")).toHaveCount(
      registrations + 1,
    );
    expect(registrations + 1).toBeLessThanOrEqual(allYearsOptions);
  });
});
