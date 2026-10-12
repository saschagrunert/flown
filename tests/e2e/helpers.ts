/**
 * Shared helper functions for e2e tests
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
// Type-only import so the window.mapApp / MAP_CONFIG globals are declared
import type {} from "../../flown/frontend/globals";
import { STATE_SCHEMA_VERSION } from "../../flown/frontend/state/urlState";
import {
  airportPosition,
  containerPoint,
  pathCount,
  ribbonCount,
  setView,
  waitForMapReady,
} from "./map";

/**
 * The years the built site carries, as the year filter spells them. Read
 * from the exported metadata so the specs follow the data set instead of
 * breaking when another year of flights is committed.
 */
export async function knownYears(page: Page): Promise<string[]> {
  const years = await page.evaluate(() =>
    (window.mapApp?.siteData.metadata?.available_years ?? []).map(String),
  );
  expect(years.length, "the site exports no years").toBeGreaterThan(0);
  return years;
}

interface SegmentClickPosition {
  x: number;
  y: number;
  coord: number[];
  pathId?: number | undefined;
}

export interface ErrorCollector {
  pageErrors: string[];
  consoleErrors: string[];
  cspViolations: string[];
}

/**
 * Collect uncaught errors, console errors and Content Security Policy
 * violations for the lifetime of the page. Call before page.goto().
 */
export async function attachErrorCollectors(
  page: Page,
): Promise<ErrorCollector> {
  const collector: ErrorCollector = {
    pageErrors: [],
    consoleErrors: [],
    cspViolations: [],
  };
  page.on("pageerror", (err) => collector.pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") collector.consoleErrors.push(msg.text());
  });
  await page.exposeFunction("__reportCspViolation", (text: string) => {
    collector.cspViolations.push(text);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = `${event.violatedDirective}: ${event.blockedURI}`;
      (
        window as unknown as { __reportCspViolation: (t: string) => void }
      ).__reportCspViolation(report);
    });
  });
  return collector;
}

/**
 * Every console error. The fixture in fixtures.ts answers all CDN and tile
 * requests locally, so a failed resource load is a defect of the page or of
 * the test setup, never a network hiccup to filter out.
 *
 * Not the page's: in WebKit, "Refused to apply a stylesheet because its
 * hash, its nonce, or 'unsafe-inline' does not appear in the style-src
 * directive" in a trace after a failure. Playwright adds and removes a
 * <style> element to line up the animations before every screenshot in
 * WebKit, which the CSP refuses; only the screenshot of a failed test takes
 * one here, after the checks.
 */
export function relevantConsoleErrors(collector: ErrorCollector): string[] {
  return collector.consoleErrors;
}

/**
 * Wait until every running CSS animation and transition below `target` has
 * finished. Animations that never end (spinners) are left alone.
 *
 * The control surfaces slide and fade in, so anything that measures
 * geometry or scans the page for contrast has to let that settle first: a
 * box read part-way through moves on its own, and axe sees the colours of
 * the half-faded frame.
 */
export async function settleAnimations(target: Page | Locator): Promise<void> {
  const root = "goto" in target ? target.locator(":root") : target;
  await root.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((animation) =>
          Number.isFinite(
            Number(animation.effect?.getComputedTiming().endTime ?? 0),
          ),
        )
        // A cancelled animation rejects; it is over either way
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Open the app and wait until initialization (data loading) has finished */
export async function gotoApp(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await waitForAppReady(page);
}

/** Wait for the app to finish initializing (also after a reload) */
export async function waitForAppReady(page: Page): Promise<void> {
  await waitForMapReady(page);
  await page.waitForFunction(
    () => {
      const app = window.mapApp;
      return !!app && !app.isInitializing && !!app.map;
    },
    undefined,
    { timeout: 20000 },
  );
  // Initializing can zoom the map once more (a restored view, the bounds)
  await waitForMapReady(page);
}

/**
 * A toast on screen with the given text. Not `page.getByText`: the message
 * is also written to a visually hidden live region a moment after the toast
 * appears, and from then on the text matches two elements, which a strict
 * locator refuses. Whether a spec got its answer before that was a race.
 */
export function toastMessage(page: Page, text: string): Locator {
  return page.locator(".toast-notification").filter({ hasText: text });
}

/** Read the persisted app state from localStorage */
export function readSavedState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("flown-state") || "{}") as Record<
        string,
        unknown
      >,
  );
}

/** Wait until the year filter has been applied and its data is loaded */
export async function waitForYearFilter(
  page: Page,
  year: string,
): Promise<void> {
  await page.waitForFunction(
    (y) => {
      const app = window.mapApp;
      if (!app || app.selectedYear !== y) return false;
      const data = app.currentData;
      if (!data) return false;
      if (y === "all") return true;
      return data.path_info.every((p) => String(p.year) === y);
    },
    year,
    { timeout: 15000 },
  );
}

/** Wait until the aircraft filter has been applied */
export async function waitForAircraftFilter(
  page: Page,
  aircraft: string,
): Promise<void> {
  await page.waitForFunction(
    (a) => window.mapApp?.selectedAircraft === a,
    aircraft,
    { timeout: 15000 },
  );
}

/**
 * Find a path segment coordinate far from any airport marker, zoom to it,
 * and return its container position. Useful for clicking/hovering on paths
 * without hitting airport markers.
 */
export async function findSegmentFarFromAirports(
  page: Page,
  options?: { includePathId?: boolean },
): Promise<SegmentClickPosition | null> {
  const airports = await Promise.all(
    (await page.evaluate(() => Object.keys(window.mapApp!.airportMarkers))).map(
      (name) => airportPosition(page, name),
    ),
  );

  const best = await page.evaluate((markers) => {
    const segments = window.mapApp?.currentData?.path_segments;
    if (!segments || segments.length === 0) return null;

    let found: { pathId: number; coord: number[]; dist: number } | null = null;
    for (const seg of segments) {
      if (!seg.coords || seg.coords.length < 2) continue;
      const midCoord = seg.coords[Math.floor(seg.coords.length / 2)]!;
      const minDist = markers.reduce((min, [lat, lon]) => {
        const d = Math.hypot(midCoord[0] - lat, midCoord[1] - lon);
        return Math.min(min, d);
      }, Infinity);
      if (!found || minDist > found.dist) {
        found = { pathId: seg.path_id, coord: midCoord, dist: minDist };
      }
    }
    return found;
  }, airports);
  if (!best) return null;

  // Wait until the view has settled before asking where the point is drawn
  const at = [best.coord[0]!, best.coord[1]!] as const;
  await setView(page, at, 13);
  return {
    ...(await containerPoint(page, at)),
    coord: best.coord,
    pathId: options?.includePathId ? best.pathId : undefined,
  };
}

/* ==========================================================================
   Mobile bar and sheet

   Below the breakpoint the two control columns are replaced by the bottom
   bar, so the specs that are about behaviour rather than desktop chrome
   drive whichever control the viewport actually offers.
   ========================================================================== */

/** Matches MOBILE_BREAKPOINT_PX in utils/constants.ts (see utils/device.ts) */
export const MOBILE_BAR_BREAKPOINT_PX = 768;

/** Whether this viewport gets the bottom bar instead of the columns */
export function usesMobileBar(page: Page): Promise<boolean> {
  return page.evaluate(
    (limit) => window.innerWidth < limit,
    MOBILE_BAR_BREAKPOINT_PX,
  );
}

/** Bar tabs that open the sheet */
export type SheetTab = "layers" | "filter" | "more";

/** Open a sheet-backed tab and wait until the sheet is showing */
export async function openMobileSheet(
  page: Page,
  tab: SheetTab,
): Promise<void> {
  await page.locator(`#mobile-tab-${tab}`).click();
  await expect(page.locator("#mobile-sheet")).toBeVisible();
  // The tab carries no aria-expanded: the sheet is modal and covers the
  // whole bar, so the tab is not an operable disclosure while it is open.
  // The class is what says which tab the sheet belongs to.
  await expect(page.locator(`#mobile-tab-${tab}`)).toHaveClass(/\bactive\b/);
}

/** Dismiss the sheet through its own close control */
export async function closeMobileSheet(page: Page): Promise<void> {
  const sheet = page.locator("#mobile-sheet");
  if (!(await sheet.isVisible())) return;
  await page.locator(".sheet-close").click();
  await expect(sheet).toBeHidden();
}

/** The desktop button and the sheet row that drive the same layer */
const LAYER_CONTROLS = {
  heatmap: { buttonId: "heatmap-btn", rowId: "heatmap" },
  airports: { buttonId: "airports-btn", rowId: "airports" },
  altitude: { buttonId: "altitude-btn", rowId: "altitude" },
  airspeed: { buttonId: "airspeed-btn", rowId: "speed" },
  aviation: { buttonId: "aviation-btn", rowId: "aviation" },
  // Not layers, but switches of the same kind in the same two places
  globe: { buttonId: "globe-btn", rowId: "globe" },
  satellite: { buttonId: "satellite-btn", rowId: "satellite" },
} as const;

export type LayerName = keyof typeof LAYER_CONTROLS;

/**
 * The button in the desktop column. It stays in the document below the
 * breakpoint, where it is the state the bar mirrors rather than a control.
 */
export function layerButton(page: Page, layer: LayerName): Locator {
  return page.locator("#" + LAYER_CONTROLS[layer].buttonId);
}

/**
 * Whether a toggle is on. On or off, it is drawn at full strength: only a
 * control that is unavailable is dimmed, and a toggle that is off only
 * lacks the accent.
 */
export async function expectToggle(
  button: Locator,
  on: boolean,
): Promise<void> {
  await expect(button).toHaveAttribute("aria-pressed", String(on));
  await expect(button).toHaveCSS("opacity", "1");
}

/** The switch the mobile Layers sheet carries for a layer */
export function layerSwitch(page: Page, layer: LayerName): Locator {
  return page.locator(`.sheet-row[data-row="${LAYER_CONTROLS[layer].rowId}"]`);
}

/**
 * Toggle a layer through whichever control this viewport offers, and wait
 * until it took. Without the post-condition a click the sheet swallowed
 * only shows up much later, in whatever the caller asserts next.
 */
export async function toggleLayer(page: Page, layer: LayerName): Promise<void> {
  const button = layerButton(page, layer);
  const wasPressed = (await button.getAttribute("aria-pressed")) === "true";

  if (await usesMobileBar(page)) {
    await openMobileSheet(page, "layers");
    await layerSwitch(page, layer).click();
    await closeMobileSheet(page);
  } else {
    await button.click();
  }

  await expect(button, `${layer} did not toggle`).toHaveAttribute(
    "aria-pressed",
    String(!wasPressed),
  );
}

/**
 * Pick an option in one of the sheet's dropdowns. They sit transparent over
 * their row so a tap opens the native picker. Headless WebKit reports such a
 * select as hidden until something forces a repaint, so selectOption times
 * out there. In WebKit the value is set and the change event fired the way a
 * pick in the native picker does, after checking what selectOption would
 * have: the select is enabled and nothing covers it.
 */
export async function chooseSheetOption(
  select: Locator,
  value: string,
): Promise<void> {
  if (select.page().context().browser()?.browserType().name() !== "webkit") {
    await select.selectOption(value);
    return;
  }
  await expect(select.locator(`option[value="${value}"]`)).toBeAttached();
  await expect(select).toBeEnabled();
  const onTop = await select.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return hit === element || element.contains(hit);
  });
  expect(onTop, "the select is covered").toBe(true);
  await select.evaluate((element, choice) => {
    (element as HTMLSelectElement).value = choice;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/**
 * Choose a filter value. The sheet mirrors the page's own dropdown and
 * writes the choice back to it, so both paths end in the same handler.
 */
async function selectFilter(
  page: Page,
  rowId: string,
  sourceId: string,
  value: string,
): Promise<void> {
  if (!(await usesMobileBar(page))) {
    await page.locator("#" + sourceId).selectOption(value);
    return;
  }
  await openMobileSheet(page, "filter");
  await chooseSheetOption(
    page.locator(`.sheet-row[data-row="${rowId}"] select`),
    value,
  );
  await closeMobileSheet(page);
}

/** Filter by year through the column dropdown or the Filter sheet */
export function setYearFilter(page: Page, year: string): Promise<void> {
  return selectFilter(page, "year", "year-select", year);
}

/** Filter by aircraft through the column dropdown or the Filter sheet */
export function setAircraftFilter(page: Page, aircraft: string): Promise<void> {
  return selectFilter(page, "aircraft", "aircraft-select", aircraft);
}

/**
 * Wait until the statistics panel shows its figures. They come with the
 * Wrapped bundle, which the first opening fetches (ui/statsPanel.ts); until
 * then the rail is open over a panel that says it is loading.
 */
export async function waitForStatsContent(page: Page): Promise<Locator> {
  const panel = page.locator("#stats-panel");
  await expect(panel.locator(".kh-stats")).toBeVisible();
  await expect(panel).not.toHaveAttribute("aria-busy", "true");
  return panel;
}

/**
 * Toggle the statistics panel from the bar or the desktop button. Opened, it
 * is waited for until it shows its figures (see waitForStatsContent).
 */
export async function toggleStatsPanel(page: Page): Promise<void> {
  const mobile = await usesMobileBar(page);
  const opening = await page.locator("#stats-rail").isHidden();
  await page.locator(mobile ? "#mobile-tab-stats" : "#stats-btn").click();
  if (opening) await waitForStatsContent(page);
}

/**
 * The longest the cards of the year in review take to fill. The dialog
 * opens at once and works out the statistics of the filter in slices, with
 * a task of the page's own between two of them; in software WebGL each of
 * those may wait on a frame of the map, which took seconds with a browser
 * per core of the CI runner.
 */
const WRAPPED_CARDS_TIMEOUT_MS = 30000;

/**
 * Open the year in review from the bar or the desktop button and wait until
 * the dialog shows its cards, not only its loading line. Returns the dialog.
 */
export async function openWrapped(page: Page): Promise<Locator> {
  const mobile = await usesMobileBar(page);
  await page.locator(mobile ? "#mobile-tab-wrapped" : "#wrapped-btn").click();
  const modal = page.locator("#wrapped-modal");
  await expect(modal).toBeVisible({ timeout: 5000 });
  await waitForWrappedCards(page);
  return modal;
}

/**
 * Wait until the open Wrapped dialog has filled its cards: the column is
 * busy while the statistics are worked out, and the stats card holds a
 * loading line in place of its figures.
 */
async function waitForWrappedCards(page: Page): Promise<void> {
  await expect(page.locator("#wrapped-stats .stat-card").first()).toBeVisible({
    timeout: WRAPPED_CARDS_TIMEOUT_MS,
  });
  await expect(page.locator("#wrapped-cards-column")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
}

/**
 * Wait until the open Wrapped dialog shows its map. The panel holds a
 * placeholder until the map's tiles have landed: it lies over the map and
 * takes the pointer, and it shimmers forever, so `settleAnimations` does
 * not wait for it.
 */
export async function waitForWrappedMap(page: Page): Promise<void> {
  await expect(
    page.locator("#wrapped-map-container:not(.is-awaiting-map)"),
  ).toBeAttached();
}

/**
 * The id of the first path of the loaded data set. Ids are content hashes,
 * so this is whatever id the first flight has, not a small number.
 */
export async function firstPathId(page: Page): Promise<number> {
  await waitForPathData(page);
  return page.evaluate(() => window.mapApp!.fullPathInfo![0]!.id);
}

/**
 * The query parameters of a link that selects `pathIds`, with the schema
 * version the app requires before it applies them. Schema 4 spells the ids
 * in base 36.
 */
export function selectionParams(...pathIds: number[]): string {
  const ids = pathIds.map((id) => id.toString(36)).join(",");
  return `p=${ids}&sv=${STATE_SCHEMA_VERSION}`;
}

/**
 * Toggle one path in or out of the selection and check that the selection
 * has the expected size, so the change has taken before the caller asserts
 * on anything that follows from it. The toggle is synchronous, so the size
 * is read in the same evaluation: a waitForFunction polls once a frame, and
 * in the 3D view on a busy runner's software WebGL a frame took 2.7 s, so
 * the poll that would have passed at once ran out of its 5 s.
 */
export async function togglePathSelection(
  page: Page,
  pathId: number,
  expectedSize: number,
): Promise<void> {
  const size = await page.evaluate((id) => {
    const app = window.mapApp!;
    app.pathSelection.togglePathSelection(id);
    return app.selectedPathIds.size;
  }, pathId);
  expect(size).toBe(expectedSize);
}

/**
 * How long the helpers that load and replay flights wait for each step. A
 * spec in the relief of the 3D view passes its own: a frame there took
 * 2.7 to 16 s in software WebGL on a busy runner, where the flat map draws
 * one in a few milliseconds.
 */
export interface WaitOptions {
  /** For each step, in ms */
  timeout?: number;
}

/** How long a step waits for the paths of the flights on the flat map */
const PATH_DATA_TIMEOUT_MS = 15000;

/**
 * The interval a page.waitForFunction asks its predicate in (ms). By
 * default it asks once a frame, and a page that draws a frame in seconds
 * (the relief, or a page cutting the flights anew on a loaded machine)
 * asked a predicate that held at once only after it, or not before the
 * wait ran out. On a timer the page answers between two frames.
 */
const POLL_MS = 250;

/**
 * Enable altitude layer and wait for path data to load: drawn as lines, or
 * in the 3D view as ribbons, where the lines are left empty
 */
export async function waitForPathData(
  page: Page,
  { timeout = PATH_DATA_TIMEOUT_MS }: WaitOptions = {},
): Promise<void> {
  const altBtn = layerButton(page, "altitude");
  if ((await altBtn.getAttribute("aria-pressed")) !== "true") {
    await toggleLayer(page, "altitude");
  }
  await expect(altBtn).toHaveAttribute("aria-pressed", "true", { timeout });
  await page.waitForFunction(
    () => {
      const app = window.mapApp;
      return !!app && (app.fullPathInfo?.length ?? 0) > 0;
    },
    undefined,
    { timeout, polling: POLL_MS },
  );
  await expect
    .poll(
      async () =>
        (await pathCount(page, "altitude")) +
        (await ribbonCount(page, "altitude")),
      { timeout },
    )
    .toBeGreaterThan(0);
}

/** Select a single path with timing data for replay */
export async function selectPathForReplay(
  page: Page,
  options: WaitOptions = {},
): Promise<number> {
  await waitForPathData(page, options);

  const pathId = await page.evaluate(() => {
    const app = window.mapApp!;
    const segments = app.fullPathSegments || [];
    for (const seg of segments) {
      if (seg.time !== undefined && seg.time !== null) return seg.path_id;
    }
    return null;
  });
  expect(pathId).not.toBeNull();

  await togglePathSelection(page, pathId!, 1);

  return pathId!;
}

/**
 * Select the first `count` flights with times, in the order of their
 * files, which the profile and the replay of several go by
 */
export async function selectFlightsForReplay(
  page: Page,
  count: number,
): Promise<number[]> {
  await waitForPathData(page);

  const pathIds = await page.evaluate((count) => {
    const app = window.mapApp!;
    const timed = new Set(
      (app.fullPathSegments ?? [])
        .filter((segment) => (segment.time ?? 0) > 0)
        .map((segment) => segment.path_id),
    );
    return app
      .fullPathInfo!.filter((path) => timed.has(path.id))
      .slice(0, count)
      .map((path) => path.id);
  }, count);
  expect(pathIds).toHaveLength(count);

  for (const [index, id] of pathIds.entries()) {
    await togglePathSelection(page, id, index + 1);
  }
  return pathIds;
}

/**
 * Activate replay mode (select path + toggle replay). The waits take the
 * expect timeout of the project unless `timeout` says otherwise.
 */
export async function activateReplay(
  page: Page,
  options: WaitOptions = {},
): Promise<number> {
  const pathId = await selectPathForReplay(page, options);
  await expect(page.locator("#replay-btn")).toHaveAttribute(
    "title",
    "Replay selected flights",
    options,
  );
  await startReplay(page);
  await expect(page.locator("#replay-controls")).toBeVisible(options);
  return pathId;
}

/**
 * Start replay from the More sheet on mobile, the column button otherwise.
 * The sheet row closes the sheet itself before toggling replay.
 */
async function startReplay(page: Page): Promise<void> {
  if (!(await usesMobileBar(page))) {
    await page.locator("#replay-btn").click();
    return;
  }
  await openMobileSheet(page, "more");
  await page.locator('.sheet-row[data-row="replay"]').click();
}

/** Start playback and wait until the replay clock has advanced */
export async function playUntilProgress(page: Page): Promise<void> {
  await page.locator("#replay-play-btn").click();
  await expect(page.locator("#replay-pause-btn")).toBeVisible();
  // On a timer rather than once a frame, which in WebKit drawing WebGL in
  // software came too seldom for the 5 s this waited before
  await page.waitForFunction(
    () => window.mapApp!.replayState.currentTime > 0,
    undefined,
    { polling: 100, timeout: 15000 },
  );
}

const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Run an axe-core scan and fail on WCAG A/AA violations. The scan waits for
 * the page's animations first: a panel caught mid-fade has not reached its
 * final colours, and the contrast check reported that as a violation once
 * in a while.
 */
export async function expectNoA11yViolations(
  page: Page,
  label: string,
  configure?: (builder: AxeBuilder) => AxeBuilder,
): Promise<void> {
  await settleAnimations(page);
  let builder = new AxeBuilder({ page }).withTags(A11Y_TAGS);
  if (configure) builder = configure(builder);
  const results = await builder.analyze();
  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "n/a"}): ${violation.help}\n` +
        violation.nodes.map((node) => "  " + node.target.join(" ")).join("\n"),
    )
    .join("\n");
  expect(results.violations, `${label}\n${summary}`).toEqual([]);
}
