/**
 * The flight list: the Flights tab of the statistics rail. The desktop
 * project runs this; the same tabs in the phone's statistics sheet are
 * covered in mobile.spec.ts.
 */
import { test, expect, type Locator, type Page } from "./fixtures";
import {
  expectNoA11yViolations,
  gotoApp,
  knownYears,
  toggleStatsPanel,
} from "./helpers";

/** Every flight of every year, so the list has plenty to sort */
const ALL_YEARS = "/?y=all";

/** Open the rail on its Flights tab and wait for the rows */
async function openFlightList(page: Page): Promise<Locator> {
  await toggleStatsPanel(page);
  const tab = page.locator("#flights-tab");
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const panel = page.locator("#flight-list-panel");
  await expect(panel).toBeVisible();
  await expect(page.locator("#stats-panel")).toBeHidden();
  await expect(panel.locator("tbody tr").first()).toBeVisible();
  return panel;
}

/** The text of one column's cells, top to bottom */
function columnText(panel: Locator, index: number): Promise<string[]> {
  return panel
    .locator("tbody tr")
    .evaluateAll(
      (rows, i) => rows.map((row) => row.children[i]!.textContent ?? ""),
      index,
    );
}

/** The figures of a column, without the flights that have none */
async function columnFigures(panel: Locator, index: number): Promise<number[]> {
  return (await columnText(panel, index))
    .filter((text) => text !== "—")
    .map((text) => Number(text.replace(/,/g, "")));
}

test.describe("Flight list", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, ALL_YEARS);
  });

  test("lists every flight of the filter, with the tab in the link", async ({
    page,
  }) => {
    const panel = await openFlightList(page);

    const flights = await page.evaluate(
      () => window.mapApp!.currentData!.path_info.length,
    );
    await expect(panel.locator("tbody tr")).toHaveCount(flights);
    await expect(panel.locator(".flights-count")).toHaveText(
      `${flights.toLocaleString("en-US")} flights`,
    );
    await expect(page.locator("#stats-rail-title")).toContainText("Flights");
    // A year, never a date
    for (const year of await columnText(panel, 2)) {
      expect(year).toMatch(/^\d{4}$/);
    }
    await expect(page).toHaveURL(/[?&]l=1(&|$)/);

    await page.locator("#stats-tab").click();
    await expect(page.locator("#stats-panel .stats-body")).toBeVisible();
    await expect(panel).toBeHidden();
  });

  test("the tabs follow the arrow keys", async ({ page }) => {
    await openFlightList(page);
    const statsTab = page.locator("#stats-tab");
    const flightsTab = page.locator("#flights-tab");

    await flightsTab.press("ArrowRight");

    await expect(statsTab).toBeFocused();
    await expect(statsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#stats-panel")).toBeVisible();

    await statsTab.press("ArrowLeft");

    await expect(flightsTab).toBeFocused();
    await expect(page.locator("#flight-list-panel")).toBeVisible();
  });

  test("the open list has no WCAG A/AA violations", async ({ page }) => {
    const panel = await openFlightList(page);
    await panel.locator('th[data-sort="time"] button').click();
    await panel.locator("tbody .flight-btn").first().click();

    await expectNoA11yViolations(page, "flight list");
  });

  test("sorts by a column, both ways, with aria-sort", async ({ page }) => {
    const panel = await openFlightList(page);
    const header = panel.locator('th[data-sort="distance"]');
    const distance = 4;

    await header.locator("button").click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    const up = await columnFigures(panel, distance);
    expect(up.length).toBeGreaterThan(1);
    expect(up).toEqual([...up].sort((a, b) => a - b));

    await header.locator("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    const down = await columnFigures(panel, distance);
    expect(down).toEqual([...up].sort((a, b) => b - a));

    await header.locator("button").click();
    await expect(header).not.toHaveAttribute("aria-sort");
  });

  test("sorts by the full-stop landings, touch-and-goes in the title", async ({
    page,
  }) => {
    const panel = await openFlightList(page);
    const header = panel.locator('th[data-sort="landings"]');
    const landings = 6;

    await header.locator("button").click();
    await header.locator("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    const down = await columnFigures(panel, landings);
    expect(down.length).toBeGreaterThan(1);
    expect(down).toEqual([...down].sort((a, b) => b - a));
    // Flights without timestamps have no landings and come last
    const texts = await columnText(panel, landings);
    expect(texts.slice(down.length).every((text) => text === "—")).toBe(true);
    await expect(
      panel
        .locator("tbody tr")
        .first()
        .locator("td")
        .nth(landings - 1),
    ).toHaveAttribute("title", /^\d+ full stops?, \d+ touch-and-go(es)?$/);
  });

  test("searches the registrations and the airports", async ({ page }) => {
    const panel = await openFlightList(page);
    const total = await panel.locator("tbody tr").count();
    const registration = (await columnText(panel, 1)).find(
      (text) => text !== "—",
    )!;

    await panel.locator(".flights-search").fill(registration.toLowerCase());

    const kept = await columnText(panel, 1);
    expect(kept.length).toBeGreaterThan(0);
    expect(new Set(kept)).toEqual(new Set([registration]));
    await expect(panel.locator(".flights-count")).toHaveText(
      new RegExp(
        `^${kept.length} of ${total.toLocaleString("en-US")} flights$`,
      ),
    );

    const route = (await columnText(panel, 0))[0]!;
    const code = route.split(" → ")[0]!;
    await panel.locator(".flights-search").fill(code);
    for (const text of await columnText(panel, 0)) {
      expect(text).toContain(code);
    }

    await panel.locator(".flights-search").fill("no such flight");
    await expect(panel.locator("tbody")).toHaveText("No flight matches");
  });
});

/**
 * One year of flights, for the specs that need only a few rows: every
 * flight of every year left the shared runner so busy that a single click
 * took seconds, and the selection spec came close to its timeout. The page
 * opens on the latest year, the only one it can tell without loading the
 * others; the metadata has no count of flights per year.
 */
test.describe("Flight list selection", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    const latest = Math.max(...(await knownYears(page)).map(Number));
    const { year, flights } = await page.evaluate(() => ({
      year: window.mapApp!.selectedYear,
      flights: window.mapApp!.currentData!.path_info.length,
    }));
    expect(year, "the page opens on the latest year").toBe(String(latest));
    expect(flights, "three flights to select").toBeGreaterThanOrEqual(3);
  });

  test("selects a flight alone, and adds one with Shift", async ({ page }) => {
    const panel = await openFlightList(page);
    const buttons = panel.locator("tbody .flight-btn");
    const second = buttons.nth(1);
    const id = Number(await second.getAttribute("data-path-id"));

    await second.click();

    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(buttons.first()).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(() => [...window.mapApp!.selectedPathIds]),
    ).toEqual([id]);
    await expect(page.locator("#selection-chip-count")).toHaveText(
      "1 flight selected",
    );

    const third = buttons.nth(2);
    await third.click({ modifiers: ["Shift"] });

    await expect(third).toHaveAttribute("aria-pressed", "true");
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#selection-chip-count")).toHaveText(
      "2 flights selected",
    );
  });
});
