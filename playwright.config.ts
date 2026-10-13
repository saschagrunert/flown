import { defineConfig, devices } from "@playwright/test";
import { type Site, type SiteOptions, SITES } from "./tests/e2e/sites";

const isCI = !!process.env["CI"];
/**
 * Pixel comparisons only mean anything where the rendering is fixed, so the
 * visual project exists only inside the Playwright image the snapshots were
 * generated in (see CONTRIBUTING.md). Elsewhere it is left out entirely, so
 * a plain `npx playwright test` does not fail on font rendering that was
 * never going to match. The image sets PLAYWRIGHT_BROWSERS_PATH;
 * VISUAL_SNAPSHOTS=1 forces it on for anyone with an equivalent setup. Not
 * VISUAL: that is the standard variable naming a user's editor, and it is
 * already set on most Unix systems.
 */
const runsVisual =
  process.env["PLAYWRIGHT_BROWSERS_PATH"] === "/ms-playwright" ||
  !!process.env["VISUAL_SNAPSHOTS"];
const chromiumPath = process.env["CHROMIUM_PATH"];
/**
 * A second run in the same CI job (the tests without a tile API key, see the
 * e2e job of .github/workflows/test.yml) writes its traces, report and test
 * durations beside the first run's: Playwright empties its output directory
 * when it starts, and the first run's traces would go with it.
 */
const runSuffix = process.env["E2E_RUN"] ? `-${process.env["E2E_RUN"]}` : "";
const launchOptions = chromiumPath
  ? { launchOptions: { executablePath: chromiumPath } }
  : {};

/**
 * The tests that drive the controls of only one layout carry a tag at the
 * end of their title: @desktop for the columns, legends and hover of a
 * pointer device, @touch for the tap of a touch device. They still skip
 * themselves elsewhere, but Playwright splits a project into the shards of
 * the e2e job by the number of tests, counting those that skip at runtime,
 * so a shard that drew most of them finished minutes before the others.
 * Left out here, they are not counted at all.
 */
const DESKTOP_ONLY = /@desktop\b/;
const TOUCH_ONLY = /@touch\b/;

function siteServer(site: Site) {
  return {
    command: `python3 -m http.server ${site.port} -d ${site.dir}`,
    port: site.port,
    reuseExistingServer: !isCI,
    // http.server logs every request to stderr
    stderr: "ignore" as const,
  };
}

export default defineConfig<object, SiteOptions>({
  testDir: "tests/e2e",
  timeout: 30000,
  fullyParallel: true,
  forbidOnly: isCI,
  // A test that only passes on its retry is still a failure, not a green
  // run, so a retry never turns a run green: it only tells a flaky failure
  // (reported as flaky) from one that fails every time; the trace of every
  // failed attempt is kept. That is worth the time of one more attempt in
  // the desktop project alone. The mobile, visual, webkit and
  // webkit-desktop projects (below) do not retry, and neither do the heavy
  // tests in CI (HEAVY in tests/e2e/fixtures.ts), where one attempt takes
  // minutes: their job passes --retries=0, and the describe of the relief
  // tests in 3d-relief.spec.ts turns retries off in every project.
  // failOnFlakyTests is what holds that: a run with a test that passed only
  // on its retry fails all the same, and the retry just labels it flaky.
  retries: isCI ? 1 : 0,
  failOnFlakyTests: isCI,
  // One browser per core of the runner, each drawing WebGL in software. The
  // e2e job of .github/workflows/test.yml splits the desktop, mobile and
  // webkit projects into shards, and runs the heavy tests of the desktop and
  // webkit-desktop projects, the slowest to draw, on a runner of their own
  // with two browsers (--workers=2) in either engine.
  ...(isCI ? { workers: "100%" } : {}),
  // The console reporter Playwright would pick anyway, plus the HTML report
  // that CI uploads with the traces when a run fails. CI also writes the
  // duration of every test, which it uploads from every run: the tests that
  // creep up on their timeout show there before they time out
  // (scripts/e2e_durations.js lists the slowest).
  outputDir: `test-results${runSuffix}`,
  reporter: [
    [isCI ? "dot" : "list"],
    ["html", { open: "never", outputFolder: `playwright-report${runSuffix}` }],
    ...(isCI
      ? [
          [
            "json",
            { outputFile: `test-results${runSuffix}/e2e-timings.json` },
          ] as const,
        ]
      : []),
  ],
  // A stale site is refused by a fixture every spec gets (see
  // tests/e2e/site-check.ts), not by a global setup or a setup project
  use: {
    baseURL: `http://localhost:${SITES.docs.port}`,
    headless: true,
    // The page honours prefers-reduced-motion, so the entry animations and
    // slide transitions are skipped and a scan never catches a half-faded
    // panel. Specs that measure animations settle them explicitly as well.
    reducedMotion: "reduce",
    // Kept for every failed attempt: the mobile project does not retry, so
    // "on-first-retry" never recorded a trace there
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      // The bar and sheet only exist below the breakpoint; the visual
      // snapshots have a project of their own
      testIgnore: /(mobile|visual)\.spec\.ts$/,
      grepInvert: TOUCH_ONLY,
      // Software WebGL with four browsers on the runner: the slowest specs
      // (Wrapped's intro, the error-free scans, the cross-section, the
      // selections) took 70 to 80 % of the old 30 s on green runs, and one
      // of them timed out on three runs that changed nothing it drives
      timeout: 45000,
      use: {
        ...devices["Desktop Chrome"],
        ...launchOptions,
      },
    },
    {
      name: "mobile",
      // mobile.spec.ts drives the bottom bar and sheet; the others are
      // viewport-agnostic and run against whichever controls the bar puts
      // up, Your flights from the More sheet
      testMatch: /(core|layers|local-flights|mobile|state)\.spec\.ts$/,
      grepInvert: DESKTOP_ONLY,
      // The bar and sheet are built at runtime and every interaction here
      // goes through them, so a retry would hide exactly the intermittent
      // failures this project exists to catch
      retries: 0,
      // Software WebGL at the Pixel 7's 2.6x pixel ratio, one browser per
      // core of the runner: with the airport labels fading in and out on
      // every move, every step of a spec takes one to four seconds there,
      // against a tenth of that on a desktop. The specs that load the page
      // twice, or replay over an open sheet, took 31 s in CI; a spec that
      // hangs still fails
      timeout: 60000,
      use: {
        ...devices["Pixel 7"],
        ...launchOptions,
      },
    },
    ...(runsVisual
      ? [
          {
            name: "visual",
            testMatch: /visual\.spec\.ts$/,
            retries: 0,
            use: {
              ...devices["Desktop Chrome"],
              ...launchOptions,
              // The fixture site: the snapshots allow no differing pixel, so
              // the flights in them must not change with data/
              baseURL: `http://localhost:${SITES.visual.port}`,
              site: "visual" as const,
            },
          },
        ]
      : []),
    {
      name: "webkit",
      // The page targets iOS and leans on :has(), @starting-style and dvh,
      // so the phone interface also runs in Safari's engine. Install it with
      // `npx playwright install webkit`. The same specs as the mobile
      // project: the layers and the saved state set up the WebGL layers,
      // the heat lines and the 3D view, which Safari draws with a WebGL of
      // its own. Of search.spec.ts only the search on a phone, which the
      // grepInvert below leaves: iOS zooms into a small field and keeps the
      // page scrolled after its keyboard.
      testMatch: /(core|layers|mobile|search|state)\.spec\.ts$/,
      grepInvert: DESKTOP_ONLY,
      // Like the mobile project: a retry would hide the flaky bar and sheet
      retries: 0,
      // Software WebGL on a phone, as in the mobile project
      timeout: 60000,
      use: {
        ...devices["iPhone 15"],
      },
    },
    {
      name: "webkit-desktop",
      // Turning, tilting, the globe, the relief, the replay and the
      // interactions that must not log an error in Safari's engine. Their
      // specs drive the desktop controls, which is why they run in a desktop
      // viewport rather than in the webkit project above.
      testMatch: /(3d-relief|error-free|orientation|replay)\.spec\.ts$/,
      // Like the phone projects: a retry would not turn the run green
      // (failOnFlakyTests), and an attempt in Safari's engine drawing WebGL
      // in software is slow
      retries: 0,
      // Software WebGL, in a browser CI has no GPU for either
      timeout: 60000,
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
  // A server whose directory is missing still starts and answers 404, so a
  // run that needs only one of the sites is not held up by the other
  webServer: [
    siteServer(SITES.docs),
    ...(runsVisual ? [siteServer(SITES.visual)] : []),
  ],
});
