/**
 * The start of the page (startApp in mapApp.ts): on the site's flights, or
 * on the ones a visitor dropped and asked to see, whose bundle hands over
 * the configuration of that dataset before the app is made and reopens its
 * panel after the reload that switched the flights. And the watch for
 * files dragged over the page, which initMapApp installs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MapApp,
  initMapApp,
  startApp,
} from "../../../../flown/frontend/mapApp";
import {
  LOCAL_FLIGHTS_KEY,
  REOPEN_KEY,
} from "../../../../flown/frontend/state/localFlags";
import { LOCAL_UNAVAILABLE_MESSAGE } from "../../../../flown/frontend/ui/lazyBundles";
import { loadLocal } from "../../../../flown/frontend/services/featureLoader";
import { showToast } from "../../../../flown/frontend/utils/toast";
import { setLocalStateMode } from "../../../../flown/frontend/ui/stateManager";
import { UNREAD_LINK_MESSAGE } from "../../../../flown/frontend/state/shareToken";
import { SHARE_TOKEN_PARAM } from "../../../../flown/frontend/state/urlState";

const loggerMock = vi.hoisted(() => ({ logDebug: vi.fn(), logError: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/logger", () => loggerMock);
vi.mock("../../../../flown/frontend/utils/toast", async (original) => ({
  ...(await original<
    typeof import("../../../../flown/frontend/utils/toast")
  >()),
  showToast: vi.fn(),
}));

const bundle = vi.hoisted(() => ({
  localStartConfig: vi.fn(),
  reopenAfterSwitch: vi.fn(),
  showDropSheet: vi.fn(),
  toggleLocalFlights: vi.fn(),
}));
vi.mock("../../../../flown/frontend/ui/stateManager", async (original) => ({
  ...(await original<
    typeof import("../../../../flown/frontend/ui/stateManager")
  >()),
  setLocalStateMode: vi.fn(),
}));
vi.mock(
  "../../../../flown/frontend/services/featureLoader",
  async (original) => ({
    ...(await original<
      typeof import("../../../../flown/frontend/services/featureLoader")
    >()),
    loadLocal: vi.fn(() => Promise.resolve(bundle)),
  }),
);

const config = {
  center: [48.0, 16.0] as [number, number],
  bounds: [
    [47.0, 15.0],
    [49.0, 17.0],
  ] as [[number, number], [number, number]],
  dataDir: "data",
};

const localConfig = {
  ...config,
  dataDir: "local",
  localFlights: {
    years: [2025],
    flights: 1,
    airports: 1,
    center: [50, 8] as [number, number],
    bounds: [
      [49, 7],
      [51, 9],
    ] as [[number, number], [number, number]],
    files: ["a.kml"],
    builtAt: 1,
  },
};

type DragLike = Event & { dataTransfer: unknown };

function drag(type: string, transfer: unknown): DragLike {
  const event = new Event(type, { cancelable: true }) as DragLike;
  event.dataTransfer = transfer;
  return event;
}

let apps: MapApp[];

beforeEach(() => {
  apps = [];
  vi.spyOn(MapApp.prototype, "initialize").mockImplementation(function (
    this: MapApp,
  ) {
    this.isInitializing = false;
    apps.push(this);
    return Promise.resolve();
  });
  bundle.localStartConfig.mockResolvedValue(null);
});

afterEach(() => {
  for (const app of apps) app.destroy();
  delete window.mapApp;
});

describe("startApp", () => {
  it("says so when a shared link could not be read, as a chat client cut it short", async () => {
    const original = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", `/?${SHARE_TOKEN_PARAM}=BAA`);
    try {
      await startApp(config);
    } finally {
      window.history.replaceState(null, "", original);
    }

    expect(showToast).toHaveBeenCalledWith(UNREAD_LINK_MESSAGE, "error");
  });

  it("starts on the site's flights without the flag, asking no bundle", async () => {
    const app = await startApp(config);

    expect(app.config).toBe(config);
    expect(loadLocal).not.toHaveBeenCalled();
    expect(bundle.reopenAfterSwitch).not.toHaveBeenCalled();
  });

  it("starts on the visitor's flights when the flag is set", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    bundle.localStartConfig.mockResolvedValue(localConfig);

    const app = await startApp(config);

    expect(bundle.localStartConfig).toHaveBeenCalledWith(config);
    expect(app.config).toBe(localConfig);
    expect(bundle.reopenAfterSwitch).toHaveBeenCalledWith(app);
    // The saved state of those flights, told before the app reads any
    expect(setLocalStateMode).toHaveBeenCalledWith(true);
  });

  it("tells the saved state it is the site's flights' otherwise", async () => {
    await startApp(config);

    expect(setLocalStateMode).toHaveBeenCalledWith(false);
  });

  it("asks the bundle only to reopen its panel after going back to the site's flights", async () => {
    sessionStorage.setItem(REOPEN_KEY, "1");
    bundle.localStartConfig.mockResolvedValue(localConfig);

    const app = await startApp(config);

    // The dataset is still kept, and is not what the page opens on
    expect(bundle.localStartConfig).not.toHaveBeenCalled();
    expect(app.config).toBe(config);
    expect(bundle.reopenAfterSwitch).toHaveBeenCalledWith(app);
  });

  it("opens a shared link on the site's flights, whoever follows it", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    bundle.localStartConfig.mockResolvedValue(localConfig);
    history.replaceState(null, "", "?c=abc");
    try {
      const app = await startApp(config);

      expect(app.config).toBe(config);
      expect(loadLocal).not.toHaveBeenCalled();
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("turns a shared link's token into the link before the app reads it", async () => {
    // y=2025&p=a5&sv=4&i=1, packed by Copy link (state/shareToken.ts)
    history.replaceState(null, "", "/?c=AgIT9I52g");
    let read = "";
    vi.mocked(MapApp.prototype.initialize).mockImplementation(function (
      this: MapApp,
    ) {
      read = location.search;
      this.isInitializing = false;
      apps.push(this);
      return Promise.resolve();
    });
    try {
      await startApp(config);

      expect(read).toBe("?y=2025&p=a5&sv=4&i=1");
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("stays on the visitor's flights for the state the page keeps in its URL", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    bundle.localStartConfig.mockResolvedValue(localConfig);
    history.replaceState(null, "", "?v=3&y=2025&z=8");
    try {
      const app = await startApp(config);

      expect(app.config).toBe(localConfig);
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("falls back to the site's flights when the bundle cannot be fetched", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    vi.mocked(loadLocal).mockResolvedValueOnce(null);

    const app = await startApp(config);

    expect(app.config).toBe(config);
    expect(showToast).toHaveBeenCalledWith(LOCAL_UNAVAILABLE_MESSAGE, "error");
  });
});

describe("the watch for files dragged over the page", () => {
  it("is installed by initMapApp and brings in the bundle for the sheet", async () => {
    const app = await initMapApp(config);

    window.dispatchEvent(drag("dragenter", { types: ["Files"], files: [] }));

    await vi.waitFor(() => expect(bundle.showDropSheet).toHaveBeenCalled());
    expect(bundle.showDropSheet).toHaveBeenCalledWith(app);
  });

  it("hands a drop to Your flights", async () => {
    const app = await initMapApp(config);
    const toggle = vi
      .spyOn(app, "toggleLocalFlights")
      .mockImplementation(() => {});
    const files = [new File(["x"], "a.kml")];

    window.dispatchEvent(drag("drop", { types: ["Files"], files }));

    expect(toggle).toHaveBeenCalledWith(files);
  });
});
