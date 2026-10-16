/**
 * The lazily loaded bundles and the stylesheets that go with them.
 *
 * Replay and Wrapped are a quarter of the frontend and most visits open
 * neither, so each is fetched on first use, from a bundle of its own. A
 * failure has to leave the rest of the map working, and two callers arriving
 * at once must not fetch twice. Both files have to arrive: a panel drawn
 * without its stylesheet is worse than the toast a failed load produces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXTRAS_CSS_URL,
  FEATURES_CSS_URL,
  LOCAL_CSS_URL,
  SEARCH_CSS_URL,
  SITE_UPDATED_MESSAGE,
  WRAPPED_CSS_URL,
  loadedExtras,
  loadedFeatures,
  loadExtras,
  loadFeatures,
  loadLocal,
  loadSearch,
  loadWrapped,
  resetExtrasLoader,
  resetFeatureLoader,
  resetLocalLoader,
  resetSearchLoader,
  resetWrappedLoader,
  wasSiteUpdated,
} from "../../../../flown/frontend/services/featureLoader";
import type { FeatureModule } from "../../../../flown/frontend/features";
import type { WrappedModule } from "../../../../flown/frontend/wrapped";
import type { SearchModule } from "../../../../flown/frontend/search";
import type { ExtrasModule } from "../../../../flown/frontend/extras";
import type { LocalModule } from "../../../../flown/frontend/local";
import { logError } from "../../../../flown/frontend/utils/logger";

vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

const loadStylesheet = vi.hoisted(() => vi.fn());
vi.mock("../../../../flown/frontend/services/stylesheet", () => ({
  loadStylesheet,
}));

const features = {
  ReplayManager: vi.fn(),
  listFlights: vi.fn(),
  followTerrain: vi.fn(),
  followHeatCloud: vi.fn(),
  followSelectionRibbons: vi.fn(),
} as unknown as FeatureModule;

const wrapped = {
  WrappedManager: vi.fn(),
} as unknown as WrappedModule;

/** Stands in for `import("../features")` */
const importFeatures =
  vi.fn<(failedImports: number) => Promise<FeatureModule>>();

/** Stands in for `import("../wrapped")` */
const importWrapped =
  vi.fn<(failedImports: number) => Promise<WrappedModule>>();

const search = { toggleSearch: vi.fn() } as unknown as SearchModule;

/** Stands in for `import("../search")` */
const importSearch = vi.fn<(failedImports: number) => Promise<SearchModule>>();

describe("loadFeatures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    importFeatures.mockResolvedValue(features);
    loadStylesheet.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("imports the bundle and returns its exports", async () => {
    await expect(loadFeatures()).resolves.toBe(features);
    expect(importFeatures).toHaveBeenCalledTimes(1);
  });

  it("hands out the bundle once it has arrived, without fetching it", async () => {
    expect(loadedFeatures()).toBeNull();
    expect(importFeatures).not.toHaveBeenCalled();

    const pending = loadFeatures();
    expect(loadedFeatures()).toBeNull();
    await pending;

    expect(loadedFeatures()).toBe(features);
  });

  it("hands out nothing for a bundle that could not be loaded", async () => {
    importFeatures.mockRejectedValue(new Error("offline"));

    await loadFeatures();

    expect(loadedFeatures()).toBeNull();
  });

  it("fetches the stylesheet alongside the bundle", async () => {
    await loadFeatures();

    expect(loadStylesheet).toHaveBeenCalledWith(FEATURES_CSS_URL);
    // Relative to the page, which is not at the root of its host
    expect(FEATURES_CSS_URL.startsWith("./")).toBe(true);
  });

  it("does not fetch again once both have arrived", async () => {
    await loadFeatures();
    vi.clearAllMocks();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures).not.toHaveBeenCalled();
    expect(loadStylesheet).not.toHaveBeenCalled();
  });

  it("resolves with null and reports when the stylesheet cannot be loaded", async () => {
    loadStylesheet.mockRejectedValue(new Error("offline"));

    await expect(loadFeatures()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("fetches both again when only the stylesheet failed", async () => {
    // The import succeeded even though the load as a whole failed; the next
    // attempt must not take that for a finished load
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));
    await expect(loadFeatures()).resolves.toBeNull();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures).toHaveBeenCalledTimes(2);
    expect(loadStylesheet).toHaveBeenCalledTimes(2);
  });

  it("shares one request between callers that arrive together", async () => {
    let settle: () => void = () => {};
    importFeatures.mockImplementation(
      () =>
        new Promise<FeatureModule>((resolve) => {
          settle = () => resolve(features);
        }),
    );

    const both = Promise.all([loadFeatures(), loadFeatures()]);
    settle();

    expect(await both).toEqual([features, features]);
    expect(importFeatures).toHaveBeenCalledTimes(1);
  });

  it("resolves with null and reports when the bundle cannot be loaded", async () => {
    importFeatures.mockRejectedValue(new Error("offline"));

    await expect(loadFeatures()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("gives up on an import that never settles", async () => {
    vi.useFakeTimers();
    importFeatures.mockImplementation(() => new Promise(() => {}));

    const result = loadFeatures();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(result).resolves.toBeNull();
    expect(logError).toHaveBeenCalled();
  });

  it("tries again after a failure, under a URL the browser has not failed on", async () => {
    // A browser may answer a second import() of a URL that failed with the
    // same failure, so every retry has to say how many went wrong before
    importFeatures.mockRejectedValueOnce(new Error("offline"));
    importFeatures.mockRejectedValueOnce(new Error("still offline"));
    await expect(loadFeatures()).resolves.toBeNull();
    await expect(loadFeatures()).resolves.toBeNull();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("asks for the same URL again after a timeout, which may yet finish", async () => {
    vi.useFakeTimers();
    importFeatures.mockImplementationOnce(() => new Promise(() => {}));
    const first = loadFeatures();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBeNull();

    await expect(loadFeatures()).resolves.toBe(features);

    expect(importFeatures.mock.calls).toEqual([[0], [0]]);
  });

  it("does not count a failed stylesheet as a failed import", async () => {
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));
    await expect(loadFeatures()).resolves.toBeNull();

    await loadFeatures();

    expect(importFeatures.mock.calls).toEqual([[0], [0]]);
  });
});

describe("loadWrapped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    resetWrappedLoader(importWrapped);
    importFeatures.mockResolvedValue(features);
    importWrapped.mockResolvedValue(wrapped);
    loadStylesheet.mockResolvedValue(undefined);
  });

  it("imports its own bundle and stylesheet, not the feature bundle's", async () => {
    await expect(loadWrapped()).resolves.toBe(wrapped);

    expect(importWrapped).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledWith(WRAPPED_CSS_URL);
    expect(WRAPPED_CSS_URL.startsWith("./")).toBe(true);
    // Opening Wrapped says nothing about replay
    expect(importFeatures).not.toHaveBeenCalled();
  });

  it("is loaded apart from the feature bundle", async () => {
    await loadFeatures();
    vi.clearAllMocks();

    // The feature bundle having arrived does not make Wrapped loaded ...
    await expect(loadWrapped()).resolves.toBe(wrapped);
    expect(importWrapped).toHaveBeenCalledTimes(1);

    // ... and Wrapped having arrived does not fetch the features again
    await loadFeatures();
    expect(importFeatures).not.toHaveBeenCalled();
  });

  it("does not fetch again once both have arrived", async () => {
    await loadWrapped();
    vi.clearAllMocks();

    await expect(loadWrapped()).resolves.toBe(wrapped);

    expect(importWrapped).not.toHaveBeenCalled();
    expect(loadStylesheet).not.toHaveBeenCalled();
  });

  it("shares one request between callers that arrive together", async () => {
    let settle: () => void = () => {};
    importWrapped.mockImplementation(
      () =>
        new Promise<WrappedModule>((resolve) => {
          settle = () => resolve(wrapped);
        }),
    );

    const both = Promise.all([loadWrapped(), loadWrapped()]);
    settle();

    expect(await both).toEqual([wrapped, wrapped]);
    expect(importWrapped).toHaveBeenCalledTimes(1);
  });

  it("resolves with null and reports when the stylesheet cannot be loaded", async () => {
    loadStylesheet.mockRejectedValueOnce(new Error("offline"));

    await expect(loadWrapped()).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
    // The next attempt fetches both again, under the same bundle URL
    await expect(loadWrapped()).resolves.toBe(wrapped);
    expect(importWrapped.mock.calls).toEqual([[0], [0]]);
  });

  it("tries again after a failure, under a URL the browser has not failed on", async () => {
    importWrapped.mockRejectedValueOnce(new Error("offline"));
    importWrapped.mockRejectedValueOnce(new Error("still offline"));
    await expect(loadWrapped()).resolves.toBeNull();
    await expect(loadWrapped()).resolves.toBeNull();

    await expect(loadWrapped()).resolves.toBe(wrapped);

    expect(importWrapped.mock.calls).toEqual([[0], [1], [2]]);
    // A failed Wrapped counts nothing against the feature bundle
    await loadFeatures();
    expect(importFeatures.mock.calls).toEqual([[0]]);
  });
});

describe("loadSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    resetWrappedLoader(importWrapped);
    resetSearchLoader(importSearch);
    importSearch.mockResolvedValue(search);
    loadStylesheet.mockResolvedValue(undefined);
  });

  it("imports its own bundle and stylesheet, and neither of the others", async () => {
    await expect(loadSearch()).resolves.toBe(search);

    expect(importSearch).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledWith(SEARCH_CSS_URL);
    expect(SEARCH_CSS_URL.startsWith("./")).toBe(true);
    expect(importFeatures).not.toHaveBeenCalled();
    expect(importWrapped).not.toHaveBeenCalled();
  });

  it("resolves with null and reports when the bundle cannot be loaded", async () => {
    importSearch.mockRejectedValueOnce(new Error("offline"));

    await expect(loadSearch()).resolves.toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "Could not load the search bundle:",
      expect.any(Error),
    );
  });
});

describe("loadLocal", () => {
  const local = {
    toggleLocalFlights: vi.fn(),
    localStartConfig: vi.fn(),
    reopenAfterSwitch: vi.fn(),
    showDropSheet: vi.fn(),
  } as unknown as LocalModule;
  /** Stands in for `import("../local")` */
  const importLocal = vi.fn<(failedImports: number) => Promise<LocalModule>>();

  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    resetWrappedLoader(importWrapped);
    resetSearchLoader(importSearch);
    resetLocalLoader(importLocal);
    importLocal.mockResolvedValue(local);
    loadStylesheet.mockResolvedValue(undefined);
  });

  it("imports its own bundle and stylesheet, and none of the others", async () => {
    await expect(loadLocal()).resolves.toBe(local);

    expect(importLocal).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledWith(LOCAL_CSS_URL);
    expect(LOCAL_CSS_URL.startsWith("./")).toBe(true);
    expect(importFeatures).not.toHaveBeenCalled();
    expect(importWrapped).not.toHaveBeenCalled();
    expect(importSearch).not.toHaveBeenCalled();
  });

  it("hands the bundle out once it has arrived, without fetching it again", async () => {
    await loadLocal();
    await expect(loadLocal()).resolves.toBe(local);
    expect(importLocal).toHaveBeenCalledTimes(1);
  });

  it("resolves with null and reports when the bundle cannot be loaded", async () => {
    importLocal.mockRejectedValueOnce(new Error("offline"));

    await expect(loadLocal()).resolves.toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "Could not load the Your flights bundle:",
      expect.any(Error),
    );
  });
});

describe("loadExtras", () => {
  const extras = { MobileSheet: vi.fn() } as unknown as ExtrasModule;
  /** Stands in for `import("../extras")` */
  const importExtras =
    vi.fn<(failedImports: number) => Promise<ExtrasModule>>();

  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    resetWrappedLoader(importWrapped);
    resetSearchLoader(importSearch);
    resetExtrasLoader(importExtras);
    importExtras.mockResolvedValue(extras);
    loadStylesheet.mockResolvedValue(undefined);
  });

  it("imports its own bundle and stylesheet, the phone's sheet's, and none of the others", async () => {
    expect(loadedExtras()).toBeNull();

    await expect(loadExtras()).resolves.toBe(extras);

    expect(loadedExtras()).toBe(extras);
    expect(importExtras).toHaveBeenCalledTimes(1);
    expect(loadStylesheet).toHaveBeenCalledExactlyOnceWith(EXTRAS_CSS_URL);
    expect(EXTRAS_CSS_URL.startsWith("./")).toBe(true);
    expect(importFeatures).not.toHaveBeenCalled();
    expect(importWrapped).not.toHaveBeenCalled();
    expect(importSearch).not.toHaveBeenCalled();
  });

  it("resolves with null and reports when the bundle cannot be loaded", async () => {
    importExtras.mockRejectedValueOnce(new Error("offline"));

    await expect(loadExtras()).resolves.toBeNull();
    expect(loadedExtras()).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      "Could not load the extras bundle:",
      expect.any(Error),
    );
  });
});

describe("a bundle of another build", () => {
  /** What a lazy bundle exports: the build it belongs to */
  const of = <T extends object>(module: T, build: string): T => ({
    ...module,
    BUILD: build,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetFeatureLoader(importFeatures);
    resetWrappedLoader(importWrapped);
    loadStylesheet.mockResolvedValue(undefined);
    document.body.innerHTML = "";
    vi.stubGlobal("__BUILD__", "0123456789ab");
    // A toast that is replaced leaves after its transition
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The toasts on screen that say the site was updated */
  const notices = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(".toast-notification")].filter(
      (toast) => toast.dataset["message"] === SITE_UPDATED_MESSAGE,
    );

  it("uses a bundle of the page's build", async () => {
    const module = of(features, "0123456789ab");
    importFeatures.mockResolvedValue(module);

    await expect(loadFeatures()).resolves.toBe(module);

    expect(wasSiteUpdated()).toBe(false);
    expect(notices()).toHaveLength(0);
  });

  it("does not use a bundle a deploy replaced, and offers the reload once", async () => {
    // A page opened before the deploy, whose shared.bundle.js is older
    importFeatures.mockResolvedValue(of(features, "fedcba987654"));
    importWrapped.mockResolvedValue(of(wrapped, "fedcba987654"));

    const [first, second] = await Promise.all([loadFeatures(), loadFeatures()]);
    expect(first).toBeNull();
    expect(second).toBeNull();
    // Every later use finds it so without asking the server again
    await expect(loadFeatures()).resolves.toBeNull();
    await expect(loadWrapped()).resolves.toBeNull();
    expect(importFeatures).toHaveBeenCalledTimes(1);

    // Callers see it unavailable, without the failure's toast
    vi.advanceTimersByTime(1000);
    expect(wasSiteUpdated()).toBe(true);
    expect(logError).not.toHaveBeenCalled();
    const [notice, ...more] = notices();
    expect(more).toHaveLength(0);
    expect(notice!.classList.contains("toast-info")).toBe(true);
    expect(notice!.textContent).toContain(SITE_UPDATED_MESSAGE);
    const reload = [...notice!.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload",
    );
    // jsdom cannot reload, nor can its reload be watched
    expect(reload).toBeDefined();
  });

  it("keeps a failed import an ordinary failure", async () => {
    // Exports the new bundle asks of the old shared.bundle.js and that it
    // lacks fail the import itself
    importFeatures.mockRejectedValue(
      new SyntaxError("does not provide an export named 'x'"),
    );

    await expect(loadFeatures()).resolves.toBeNull();

    expect(wasSiteUpdated()).toBe(false);
    expect(logError).toHaveBeenCalled();
    expect(notices()).toHaveLength(0);
  });

  it.each(["features.ts", "wrapped.ts", "search.ts", "extras.ts"])(
    "is told by the build %s exports",
    (entry) => {
      const source = readFileSync(
        resolve(__dirname, "../../../../flown/frontend", entry),
        "utf8",
      );
      expect(source).toMatch(
        /^export const BUILD = typeof __BUILD__ === "string" \? __BUILD__ : undefined;$/m,
      );
    },
  );
});
