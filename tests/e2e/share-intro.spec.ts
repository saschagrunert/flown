/**
 * The intro of a link to shared flights: Copy link in share mode marks the
 * link, which opens with the shared flights drawn in one after another as
 * the camera frames them, once. The mark is gone from the address bar as
 * the page opens, so a reload does not play the intro again.
 */
import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import { gotoApp, waitForAppReady } from "./helpers";
import { unpackShareToken } from "../../flown/frontend/state/shareToken";
import { SHARE_TOKEN_PARAM } from "../../flown/frontend/state/urlState";

/** The link a copied link resolves to as the page opens */
function resolvedLink(copied: string): URLSearchParams {
  const token = new URL(copied).searchParams.get(SHARE_TOKEN_PARAM);
  expect(token).not.toBeNull();
  return unpackShareToken(token!)!;
}

/**
 * Wait for the page opened from a copied link to resolve its token and
 * take the intro's mark off the address bar, which startApp and
 * MapApp.initialize do before the app listens for the visitor's input
 */
async function waitForResolvedLink(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((token) => {
        const params = new URLSearchParams(location.search);
        return params.has("p") && !params.has(token) && !params.has("i");
      }, SHARE_TOKEN_PARAM),
    )
    .toBe(true);
}

/** The id of the intro's layer on the map */
const LAYER = "share-intro";

/** What the intro was seen to draw, see watchIntro */
interface IntroSeen {
  /** The most frames its layer has drawn */
  introFrames: number;
  /**
   * Whether its trails stood on the relief at some point (the ground was
   * drawn at its height), and the most time the heat was built up to
   * while they were on the map, the heat cloud in for the heatmap; -1
   * while it was not
   */
  onRelief: boolean;
  heatUntil: number;
}

/**
 * Note from the start of every page load what the intro draws, in
 * `window` (see IntroSeen): the intro may well be over by the time the app
 * says it is ready in software WebGL
 */
async function watchIntro(page: Page): Promise<void> {
  await page.addInitScript((layer) => {
    type Style = { groundM: number; until?: number } | null;
    const w = window as unknown as IntroSeen;
    w.introFrames = 0;
    w.onRelief = false;
    w.heatUntil = -1;
    setInterval(() => {
      const app = window.mapApp;
      const drawn = app?.map?.getLayer(layer) as
        { implementation?: { frames: number; style: () => Style } } | undefined;
      const intro = drawn?.implementation;
      if (!app || !intro) return;
      w.introFrames = Math.max(w.introFrames, intro.frames);
      if ((intro.style()?.groundM ?? 0) > 0) w.onRelief = true;
      const cloud = app.map!.getLayer("heat-cloud") as
        { implementation?: { style: () => Style } } | undefined;
      const until = cloud?.implementation?.style()?.until;
      if (app.store.get("heatCloud") && typeof until === "number") {
        w.heatUntil = Math.max(w.heatUntil, until);
      }
    }, 50);
  }, LAYER);
}

function introSeen(page: Page): Promise<IntroSeen> {
  return page.evaluate(() => {
    const { introFrames, onRelief, heatUntil } = window as unknown as IntroSeen;
    return { introFrames, onRelief, heatUntil };
  });
}

function introFrames(page: Page): Promise<number> {
  return introSeen(page).then((seen) => seen.introFrames);
}

/**
 * Whether the intro started. The app decides on it as the feature bundle
 * comes in, which the profile of the shared flights showing says, and an
 * intro that plays puts its layer on the map in that same task (see
 * playShareIntro); asked two frames later, so the decision has been made
 * whatever order the two waits on the bundle ran in.
 */
function introStarted(page: Page): Promise<boolean> {
  return page.evaluate(
    (layer) =>
      new Promise<boolean>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            resolve(!!window.mapApp!.map!.getLayer(layer)),
          ),
        ),
      ),
    LAYER,
  );
}

/** Whether every fix of the shared flights is on the map */
function sharedFlightsFramed(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const map = app.map!;
    const { width, height } = map.getContainer().getBoundingClientRect();
    return app
      .currentData!.path_segments.filter((s) =>
        app.selectedPathIds.has(s.path_id),
      )
      .every((segment) =>
        segment.coords.every(([lat, lng]) => {
          const { x, y } = map.project([lng, lat]);
          return x >= 0 && x <= width && y >= 0 && y <= height;
        }),
      );
  });
}

/**
 * Share the first two flights, move the view off them, as a link may be
 * copied from anywhere, and hand on the link Copy link copies; with
 * `threeD`, in the 3D view, tilted as its control tilts it
 */
async function copyShareLink(page: Page, threeD = false): Promise<string> {
  await page.evaluate((threeD) => {
    const app = window.mapApp!;
    app.store.batch(() => {
      app.selectedPathIds = new Set([
        ...app.selectedPathIds,
        ...app.fullPathInfo!.slice(0, 2).map((path) => path.id),
      ]);
      app.isolateSelection = true;
      app.threeDVisible = threeD;
    });
    app.map!.jumpTo({ zoom: 3, pitch: threeD ? 50 : 0 });
    const w = window as unknown as { copied?: string };
    delete w.copied;
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: (text: string) => {
        w.copied = text;
        return Promise.resolve();
      },
    });
    // Handed the link to come, should the code that packs its token not
    // have come yet (UIToggles.shareLink)
    Object.defineProperty(navigator.clipboard, "write", {
      value: async (items: ClipboardItem[]) => {
        w.copied = await (await items[0]!.getType("text/plain")).text();
      },
    });
  }, threeD);
  await page.locator("#selection-link-btn").click();
  // The clipboard waits for the code that packs the token, which a busy
  // runner may take seconds to fetch
  await expect
    .poll(
      () =>
        page.evaluate(() => (window as unknown as { copied?: string }).copied),
      { timeout: 20_000 },
    )
    .toBeDefined();
  return page.evaluate(() => (window as unknown as { copied: string }).copied);
}

/** Where the camera of the map is */
function camera(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    const { lng, lat } = map.getCenter();
    return [lng, lat, map.getZoom(), map.getBearing(), map.getPitch()];
  });
}

test.describe("The intro of a link to shared flights", () => {
  // The intro is motion, which the projects turn off (playwright.config.ts):
  // under reduced motion the flights are only framed
  test.use({ reducedMotion: "no-preference" });

  test("plays once from a link copied in share mode, framing the flights @desktop", async ({
    page,
  }) => {
    test.slow();
    await watchIntro(page);
    await gotoApp(page);

    const link = await copyShareLink(page);
    expect(resolvedLink(link).get("i")).toBe("1");
    // The address bar never carries it
    expect(new URL(page.url()).searchParams.has("i")).toBe(false);

    await page.goto(link);
    // Taken off the link as the page opens
    await waitForResolvedLink(page);
    await expect
      .poll(() => introFrames(page), { timeout: 20000 })
      .toBeGreaterThan(0);
    // Played to the end, or skipped by a click on the map by its right
    // edge, below the column of controls: the trails give way to the lines
    // of the flights, which are framed
    const { width, height } = page.viewportSize()!;
    await page.mouse.click(width - 8, height * 0.6);
    await expect
      .poll(
        () =>
          page.evaluate(
            (layer) => !!window.mapApp!.map!.getLayer(layer),
            LAYER,
          ),
        { timeout: 15000 },
      )
      .toBe(false);
    expect(await sharedFlightsFramed(page)).toBe(true);
    expect(
      await page.evaluate(() =>
        window.mapApp!.map!.getLayoutProperty(
          "selection-highlight",
          "visibility",
        ),
      ),
    ).toBe("visible");
    expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
      true,
    );

    // A reload plays nothing: the feature bundle is in (the profile of the
    // shared flights fetches it), and no intro started with it
    await page.reload();
    await waitForAppReady(page);
    await expect(page.locator("#flight-profile")).toBeVisible({
      timeout: 15000,
    });
    expect(await introStarted(page)).toBe(false);
    expect(await introFrames(page)).toBe(0);
    expect(new URL(page.url()).searchParams.has("i")).toBe(false);
  });

  test("builds the heat up behind the flights by its clock, and hands it back to the heatmap at the end @desktop", async ({
    page,
  }) => {
    test.slow();
    await watchIntro(page);
    await gotoApp(page);
    expect(await page.evaluate(() => window.mapApp!.heatmapVisible)).toBe(true);
    const link = await copyShareLink(page);

    await page.goto(link);
    await expect
      .poll(() => introFrames(page), { timeout: 20000 })
      .toBeGreaterThan(0);
    // The heat cloud stood in for the heatmap, built up as far as the
    // intro's clock had come: no replay of the map, which holds controls
    await expect
      .poll(async () => (await introSeen(page)).heatUntil, { timeout: 20000 })
      .toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => window.mapApp!.replayActive)).toBe(false);
    // Played to the end, the heatmap is back and the cloud gone
    await expect
      .poll(
        () =>
          page.evaluate((layer) => {
            const app = window.mapApp!;
            return (
              !app.map!.getLayer(layer) &&
              !app.map!.getLayer("heat-cloud") &&
              !app.store.get("heatCloud")
            );
          }, LAYER),
        { timeout: 20000 },
      )
      .toBe(true);
  });

  test("keeps the tilt of the 3D view, the flights drawn on the relief and framed @desktop @heavy", async ({
    page,
  }) => {
    test.slow();
    await watchIntro(page);
    await gotoApp(page);
    const link = await copyShareLink(page, true);
    expect(resolvedLink(link).get("d")).toBe("1");

    await page.goto(link);
    await expect
      .poll(() => introFrames(page), { timeout: 60000 })
      .toBeGreaterThan(0);
    // Played to the end, the camera where it framed the flights and the
    // trails gone: on a map that draws a frame in seconds, the intro may
    // be over in a few of them, so the relief under the trails is what the
    // watch saw in any frame (see watchIntro)
    await expect
      .poll(
        () =>
          page.evaluate((layer) => !window.mapApp!.map!.getLayer(layer), LAYER),
        { timeout: 60000 },
      )
      .toBe(true);
    expect((await introSeen(page)).onRelief).toBe(true);
    const [, , , , pitch] = await camera(page);
    expect(pitch).toBeCloseTo(50, 0);
    expect(await sharedFlightsFramed(page)).toBe(true);
  });

  test("does not play over a view the visitor moved before it could start @desktop", async ({
    page,
  }) => {
    test.slow();
    await watchIntro(page);
    await gotoApp(page);
    const link = await copyShareLink(page);

    // The feature bundle, which the intro is in, held back as on a slow
    // line, while the visitor turns the wheel over the map
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/features.bundle.js*", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(link, { waitUntil: "domcontentloaded" });
    await waitForResolvedLink(page);
    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, -400);
    await waitForAppReady(page);
    const view = await camera(page);

    // In comes the bundle (the profile of the shared flights fetches it
    // too), and the view stays the visitor's
    release();
    await expect(page.locator("#flight-profile")).toBeVisible({
      timeout: 15000,
    });
    expect(await introStarted(page)).toBe(false);
    expect(await introFrames(page)).toBe(0);
    expect(await camera(page)).toEqual(view);
  });
});
