/**
 * Your flights (ui/localFlights.ts): the panel that takes the KML files a
 * visitor drops on the page, builds them in the browser and shows them in
 * place of the site's flights.
 *
 * The build runs the site's Python in Pyodide, fetched from its CDN, which
 * the hermetic suite blocks. So the worker is replaced here by a stub that
 * answers a build with the site's own data files (STUB_WORKER): what is
 * covered is the page's side, the panel, the store in the browser, the
 * reload that switches the flights, the start on them and the way back. The
 * build itself has its own tests (tests/test_browser.py and the unit tests
 * of services/localWorker.ts), and `local-flights-pyodide.spec.ts` drives
 * the real one when asked to.
 */

import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "./fixtures";
import {
  attachErrorCollectors,
  expectNoA11yViolations,
  gotoApp,
  relevantConsoleErrors,
  toastMessage,
  usesMobileBar,
  waitForAppReady,
} from "./helpers";

const FIXTURE = "tests/fixtures/visual/1_DEAGJ_DA20.kml";
const BUTTON = "#local-flights-btn";
const PANEL = "#local-flights";
const WORKER_BUNDLE = /\/localWorker\.bundle\.js(\?.*)?$/;

/**
 * A build worker that answers with the site's own data files: the page then
 * shows "your" flights, which are the site's, from the browser's storage.
 */
const STUB_WORKER = `
self.onmessage = async (event) => {
  const { id, build } = event.data;
  const say = (progress) => self.postMessage({ id, progress });
  say("Loading the Python runtime…");
  if (build.files.some((file) => file.name === "broken.kml")) {
    self.postMessage({ id, error: "No file holds a flight to export (broken.kml: not a KML file)" });
    return;
  }
  say("Parsing " + build.files.length + " KML file(s)...");
  const text = async (path) => (await fetch(new URL(path, self.location.href))).text();
  const metadata = JSON.parse(await text("data/metadata.json"));
  const files = [];
  for (const path of ["metadata.json", "airports.json"]) {
    files.push({ path, bytes: new TextEncoder().encode(await text("data/" + path)).buffer });
  }
  for (const year of metadata.available_years) {
    files.push({ path: year + "/data.json", bytes: new TextEncoder().encode(await text("data/" + year + "/data.json")).buffer });
  }
  const config = {};
  new Function("window", await text("map_config.js"))(config);
  const airports = JSON.parse(new TextDecoder().decode(files[1].bytes));
  say("  Exporting data to JSON files...");
  self.postMessage({
    id,
    done: {
      years: metadata.available_years,
      flights: build.files.length,
      airports: airports.length,
      bounds: config.MAP_CONFIG.bounds,
      files,
    },
  }, files.map((file) => file.bytes));
};
`;

async function stubWorker(page: Page): Promise<void> {
  await page.route(WORKER_BUNDLE, (route) =>
    route.fulfill({ body: STUB_WORKER, contentType: "text/javascript" }),
  );
}

const panel = (page: Page) => page.locator(PANEL);
/** What the panel says: the status, or the alert of an error beside it */
const status = (page: Page) =>
  page.locator(".local-flights-status:not(:empty)");
const shown = (page: Page) => page.locator(".local-flights-shown");

async function openPanel(page: Page): Promise<void> {
  if (await usesMobileBar(page)) {
    await page.locator("#mobile-tab-more").click();
    await page.getByRole("button", { name: "Your flights" }).click();
  } else {
    await page.locator(BUTTON).click();
  }
  await expect(panel(page)).toBeVisible();
}

/** Drop `names` of the fixtures through the panel's file picker */
async function dropFiles(page: Page, names: string[]): Promise<void> {
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      mimeType: "application/vnd.google-earth.kml+xml",
      buffer: await readFile(FIXTURE),
    })),
  );
  await panel(page).locator('input[type="file"]').setInputFiles(files);
}

/** The reload the panel makes to switch the flights, and the app after it */
async function switched(
  page: Page,
  action: () => Promise<void>,
): Promise<void> {
  const reloaded = page.waitForEvent("load");
  await action();
  await reloaded;
  await waitForAppReady(page);
}

test.describe("Your flights", () => {
  test.beforeEach(async ({ page, browserName }) => {
    // The stub stands in for the worker's script through a route of the
    // page, which WebKit does not take for a worker it starts
    test.skip(browserName === "webkit", "a worker's script is not routed");
    await stubWorker(page);
  });

  test("is not fetched by a visit that does not open it", async ({ page }) => {
    const fetched: string[] = [];
    page.on("request", (request) => {
      if (/\/local(Worker)?\.(bundle\.js|css)/.test(request.url())) {
        fetched.push(request.url());
      }
    });
    await gotoApp(page);
    expect(fetched).toEqual([]);
  });

  test("opens empty, says the site's flights are shown, and closes", async ({
    page,
  }) => {
    await gotoApp(page);
    await openPanel(page);

    await expect(shown(page)).toHaveText("Showing the site's flights");
    await expect(panel(page).locator(".local-flights-hint")).toContainText(
      "1_DEAGJ_DA20.kml",
    );
    await expect(
      page.getByRole("button", { name: "Show my flights" }),
    ).toBeHidden();
    await expect(page.getByRole("button", { name: "Remove all" })).toBeHidden();
    await expectNoA11yViolations(page, "Your flights, empty");

    await page.keyboard.press("Escape");
    await expect(panel(page)).toBeHidden();
  });

  test("builds dropped files, shows them after the reload, and goes back to the site's", async ({
    page,
  }) => {
    // Six loads of the page, each drawing the map anew: 25 to 34 s of the
    // desktop project's 45 s on green runs, longer on a phone's software
    // WebGL
    test.slow();
    const collector = await attachErrorCollectors(page);
    await gotoApp(page);
    const siteFlights = await page.evaluate(
      () => window.mapApp!.currentData!.path_info.length,
    );
    await openPanel(page);

    await switched(page, () =>
      dropFiles(page, ["1_DEAGJ_DA20.kml", "2_DEAGJ_DA20.kml"]),
    );

    // The panel reopens on the flights it built, from the browser's storage
    await expect(panel(page)).toBeVisible();
    await expect(shown(page)).toHaveText("Showing your 2 flights from 2 files");
    await expect(panel(page).locator(".local-flights-files li")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Show the site’s flights" }),
    ).toBeVisible();
    await expectNoA11yViolations(page, "Your flights with files");
    expect(await page.evaluate(() => window.mapApp!.config.dataDir)).toBe(
      "local",
    );
    expect(
      await page.evaluate(() => window.mapApp!.config.localFlights?.flights),
    ).toBe(2);
    expect(
      await page.evaluate(() => window.mapApp!.currentData!.path_info.length),
    ).toBe(siteFlights);
    if (!(await usesMobileBar(page))) {
      await expect(page.locator(BUTTON)).toHaveClass(/\bactive\b/);
    }

    // A plain reload stays on them
    await page.reload();
    await waitForAppReady(page);
    expect(await page.evaluate(() => window.mapApp!.config.dataDir)).toBe(
      "local",
    );

    // Copy link has nothing to carry them in, and says so before a press
    await openPanel(page);
    await page.keyboard.press("Escape");
    if (!(await usesMobileBar(page))) {
      await expect(page.locator("#share-btn")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await page.locator("#share-btn").click({ force: true });
      await expect(
        toastMessage(
          page,
          "Links cannot carry flights that are only in this browser",
        ),
      ).toBeVisible();
    }

    // Back to the site's flights, with the files kept
    await openPanel(page);
    await switched(page, () =>
      page.getByRole("button", { name: "Show the site’s flights" }).click(),
    );
    await expect(panel(page)).toBeVisible();
    await expect(shown(page)).toHaveText("Showing the site's flights");
    await expect(panel(page).locator(".local-flights-files li")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Show my flights" }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.mapApp!.config.dataDir)).toBe(
      "data",
    );

    // And to them again, without a build: the files have not changed
    const fetched: string[] = [];
    page.on("request", (request) => {
      if (WORKER_BUNDLE.test(request.url())) fetched.push(request.url());
    });
    await switched(page, () =>
      page.getByRole("button", { name: "Show my flights" }).click(),
    );
    await expect(shown(page)).toHaveText("Showing your 2 flights from 2 files");
    expect(fetched).toEqual([]);

    // Remove all, pressed again as it asks: the site's flights, nothing kept
    const removeAll = page.getByRole("button", { name: "Remove all" });
    await removeAll.click();
    await expect(removeAll).toHaveText("Remove all files?");
    // The ask lasts 4 s, which a slow phone's run can take to get to the
    // second press: in the page, asked again first where it ran out
    await switched(page, () =>
      removeAll.evaluate((button: HTMLElement) => {
        if (button.textContent !== "Remove all files?") button.click();
        button.click();
      }),
    );
    await expect(shown(page)).toHaveText("Showing the site's flights");
    await expect(panel(page).locator(".local-flights-files li")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove all" })).toBeHidden();
    expect(relevantConsoleErrors(collector)).toEqual([]);
  });

  test("says what a build that fails says, and keeps the site's flights", async ({
    page,
  }) => {
    await gotoApp(page);
    await openPanel(page);

    await dropFiles(page, ["broken.kml"]);

    await expect(status(page)).toHaveText(/broken\.kml: not a KML file/);
    await expect(status(page)).toHaveAttribute("role", "alert");
    await expect(shown(page)).toHaveText("Showing the site's flights");
    expect(await page.evaluate(() => window.mapApp!.config.dataDir)).toBe(
      "data",
    );
    // The file is kept, so it can be removed; the last one going removes
    // everything, and the page stays on the site's flights it shows
    await expect(panel(page).locator(".local-flights-files li")).toHaveCount(1);
    await panel(page)
      .getByRole("button", { name: "Remove broken.kml" })
      .click();
    await expect(panel(page).locator(".local-flights-files li")).toHaveCount(0);
    await expect(status(page)).toHaveText(
      "Your files are removed from this browser",
    );
  });

  test("refuses a file that is no KML", async ({ page }) => {
    await gotoApp(page);
    await openPanel(page);

    await panel(page)
      .locator('input[type="file"]')
      .setInputFiles([
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
      ]);

    await expect(status(page)).toHaveText(/Only KML and KMZ files/);
    await expect(panel(page).locator(".local-flights-files li")).toHaveCount(0);
  });

  test("a drag of files over the page brings up the sheet, and the drop opens the panel @desktop", async ({
    page,
  }) => {
    await gotoApp(page);
    const transfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["<kml/>"], "1_DEAGJ_DA20.kml", {
          type: "application/vnd.google-earth.kml+xml",
        }),
      );
      return transfer;
    });

    // The sheet comes with the drag going on over the page, which fires
    // dragover after dragover: one that ended before the bundle came puts
    // up none (ui/fileDrop.ts)
    await page.dispatchEvent("body", "dragenter", { dataTransfer: transfer });
    await expect(page.locator("#file-drop-sheet")).toBeAttached();
    await page.dispatchEvent("body", "dragover", { dataTransfer: transfer });
    await expect(page.locator("#file-drop-sheet")).toBeVisible();
    await expect(page.locator("#file-drop-sheet")).toContainText(
      "Drop the files to see your flights",
    );

    await page.dispatchEvent("body", "dragleave", { dataTransfer: transfer });
    await expect(page.locator("#file-drop-sheet")).toBeHidden();

    await page.dispatchEvent("body", "dragenter", { dataTransfer: transfer });
    await switched(page, () =>
      page.dispatchEvent("body", "drop", { dataTransfer: transfer }),
    );
    await expect(page.locator("#file-drop-sheet")).toBeHidden();
    await expect(shown(page)).toHaveText("Showing your 1 flight from 1 file");
  });
});
