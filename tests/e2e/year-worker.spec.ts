/**
 * The year files are decoded in a worker, one for all of them.
 *
 * The unit tests drive the decoder with a stand-in for the worker; only a
 * browser shows that the real one starts from the site (a module worker of
 * the page's own origin, which the CSP has to allow) and answers. Were it to
 * fail, the page would decode on the main thread and look the same, apart
 * from the error it logs.
 */
import { test, expect } from "./fixtures";
import {
  attachErrorCollectors,
  gotoApp,
  relevantConsoleErrors,
  setYearFilter,
  waitForPathData,
} from "./helpers";

test("one year worker decodes every year file", async ({ page }) => {
  const errors = await attachErrorCollectors(page);
  const workers: string[] = [];
  page.on("worker", (worker) => {
    // MapLibre starts workers of its own
    if (worker.url().endsWith("/yearWorker.bundle.js")) {
      workers.push(worker.url());
    }
  });

  await gotoApp(page);
  await waitForPathData(page);
  // The other years, which the page has not loaded yet
  await setYearFilter(page, "all");
  await waitForPathData(page);

  expect(workers).toHaveLength(1);
  expect(relevantConsoleErrors(errors)).toEqual([]);
  expect(errors.cspViolations).toEqual([]);
});
