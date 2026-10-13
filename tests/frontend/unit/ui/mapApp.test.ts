import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  INIT_ERROR_HTML,
  INIT_ERROR_MESSAGE,
  MapApp,
  UnsupportedBrowserError,
  initMapApp,
  reportInitFailure,
} from "../../../../flown/frontend/mapApp";
import { safeAreaInsets } from "../../../../flown/frontend/utils/safeArea";
import { bindActions } from "../../../../flown/frontend/ui/actions";
import { STORE_ACCESSOR_KEYS } from "../../../../flown/frontend/state/store";
import type { KMLDataset } from "../../../../flown/frontend/types";
import { createSegment } from "../../testHelpers";

const loggerMock = vi.hoisted(() => ({ logDebug: vi.fn(), logError: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/logger", () => loggerMock);

const config = {
  center: [48.0, 16.0] as [number, number],
  bounds: [
    [47.0, 15.0],
    [49.0, 17.0],
  ] as [[number, number], [number, number]],
  dataDir: "data",
};

describe("MapApp", () => {
  describe("constructor", () => {
    it("initializes with default state", () => {
      const app = new MapApp(config);

      expect(app.config).toBe(config);
      expect(app.selectedYear).toBe("all");
      expect(app.selectedAircraft).toBe("all");
      expect(app.map).toBeNull();
      expect(app.heatmapVisible).toBe(true);
      expect(app.altitudeVisible).toBe(false);
      expect(app.airspeedVisible).toBe(false);
      expect(app.airportsVisible).toBe(true);
      expect(app.aviationVisible).toBe(false);
      expect(app.isInitializing).toBe(true);
      expect(app.selectedPathIds).toEqual(new Set());
      // The handles are there before the map is: every layer hidden until
      // something shows it, the airports shown
      expect(app.heatmapLayer.isVisible()).toBe(false);
      expect(app.aviationLayer.isVisible()).toBe(false);
      expect(app.altitudeLayer.isVisible()).toBe(false);
      expect(app.airspeedLayer.isVisible()).toBe(false);
      expect(app.airportLayer.isVisible()).toBe(true);
      // The lines, then the ribbons of the 3D view from the same sources
      expect(app.altitudeLayer.ids).toEqual([
        "paths-altitude",
        "paths-altitude-selected",
        "paths-altitude-3d",
        "paths-altitude-selected-3d",
      ]);
      expect(app.airspeedLayer.ids).toEqual([
        "paths-airspeed",
        "paths-airspeed-selected",
        "paths-airspeed-3d",
        "paths-airspeed-selected-3d",
      ]);
      expect(app.threeDVisible).toBe(false);
      expect(app.airportToPaths).toEqual({});
      // An airport name is data: no key of it reaches Object.prototype
      expect(Object.getPrototypeOf(app.airportToPaths)).toBeNull();
      expect(app.airportToPaths["constructor"]).toBeUndefined();
      expect(app.airportMarkers).toEqual({});
    });
  });

  describe("store-backed properties", () => {
    let app: MapApp;

    beforeEach(() => {
      app = new MapApp(config);
    });

    it("exposes every accessor key as a property that reads the store", () => {
      for (const key of STORE_ACCESSOR_KEYS) {
        expect(app[key]).toBe(app.store.get(key));
      }
    });

    it("selectedYear getter/setter delegates to store", () => {
      app.selectedYear = "2025";
      expect(app.store.get("selectedYear")).toBe("2025");
      expect(app.selectedYear).toBe("2025");
    });

    it("selectedPathIds getter/setter delegates to store", () => {
      const ids = new Set([1, 2, 3]);
      app.selectedPathIds = ids;
      expect(app.store.get("selectedPathIds")).toBe(ids);
    });

    it.each([
      "isolateSelection",
      "heatmapVisible",
      "altitudeVisible",
      "airspeedVisible",
      "airportsVisible",
      "aviationVisible",
      "threeDVisible",
    ] as const)("%s getter/setter delegates to store", (key) => {
      const initial = app[key];
      app[key] = !initial;
      expect(app.store.get(key)).toBe(!initial);
      expect(app[key]).toBe(!initial);
    });

    it("notifies store subscribers through the setter", () => {
      const fn = vi.fn();
      app.store.subscribe("selectedAircraft", fn);

      app.selectedAircraft = "D-EAGJ";

      expect(fn).toHaveBeenCalledWith("D-EAGJ", "all");
    });

    it("fullPathInfo and fullPathSegments derive from currentData", () => {
      expect(app.fullPathInfo).toBeNull();
      expect(app.fullPathSegments).toBeNull();

      const data: KMLDataset = {
        path_segments: [createSegment({ path_id: 1 })],
        path_info: [{ id: 1 }],
        original_points: 0,
      };
      app.currentData = data;

      expect(app.store.get("currentData")).toBe(data);
      expect(app.fullPathInfo).toBe(data.path_info);
      expect(app.fullPathSegments).toBe(data.path_segments);
    });

    it("lists the paths of each airport among the flights the filter keeps", () => {
      app.currentData = {
        path_segments: [],
        path_info: [
          {
            id: 1,
            aircraft_registration: "D-ABCD",
            start_airport: "EDDF",
            end_airport: "EDDM",
          },
          {
            id: 2,
            aircraft_registration: "D-EFGH",
            start_airport: "EDDM",
            end_airport: "EDDF",
          },
        ],
        original_points: 0,
      };
      expect(app.airportToPaths["EDDF"]).toEqual(new Set([1, 2]));

      // A click on a shared airport must not select the other aircraft's
      // flight (regression)
      app.selectedAircraft = "D-EFGH";

      expect(app.airportToPaths["EDDF"]).toEqual(new Set([2]));
      expect(app.airportToPaths["EDDM"]).toEqual(new Set([2]));
    });

    it("hasTimingData delegates to store", () => {
      app.hasTimingData = true;

      expect(app.store.get("hasTimingData")).toBe(true);
    });

    it("keeps the metadata models and the ranges as plain fields", () => {
      // Nothing follows them, so they stay out of the store
      expect(app.aircraftModels).toEqual({});
      expect(app.altitudeRange).toEqual({ min: 0, max: 10000 });
      expect(app.airspeedRange).toEqual({ min: 0, max: 200 });
      expect(STORE_ACCESSOR_KEYS).not.toContain("altitudeRange");

      app.altitudeRange = { min: 100, max: 5000 };

      expect(app.altitudeRange).toEqual({ min: 100, max: 5000 });
      // A fresh copy per app, not the shared default
      expect(new MapApp(config).altitudeRange).toEqual({ min: 0, max: 10000 });
    });
  });

  describe("initMapApp", () => {
    let initSpy: ReturnType<typeof vi.spyOn>;
    let bindOrder: string[];
    let btn: HTMLButtonElement;

    beforeEach(() => {
      bindOrder = [];
      btn = document.createElement("button");
      btn.dataset["action"] = "toggleStats";
      btn.dataset["icon"] = "stats";
      document.body.appendChild(btn);

      const addSpy = vi.spyOn(HTMLElement.prototype, "addEventListener");
      addSpy.mockImplementation(function (
        this: HTMLElement,
        ...args: Parameters<HTMLElement["addEventListener"]>
      ) {
        if (!bindOrder.includes("bind")) bindOrder.push("bind");
        return EventTarget.prototype.addEventListener.apply(this, args);
      });
      initSpy = vi
        .spyOn(MapApp.prototype, "initialize")
        .mockImplementation(function (this: MapApp) {
          bindOrder.push("initialize");
          this.isInitializing = false;
          return Promise.resolve();
        });
    });

    afterEach(() => {
      btn.remove();
      delete window.mapApp;
    });

    it("creates the app, draws the icons, binds actions and then initializes", async () => {
      const app = await initMapApp(config);

      expect(app).toBeInstanceOf(MapApp);
      expect(window.mapApp).toBe(app);
      expect(bindOrder).toEqual(["bind", "initialize"]);
      expect(initSpy).toHaveBeenCalledTimes(1);
      expect(btn.querySelector("svg.icon")).not.toBeNull();

      btn.click();
      expect(app.store.get("statsPanelVisible")).toBe(true);
    });
  });

  describe("reportInitFailure", () => {
    let mapEl: HTMLElement;

    beforeEach(() => {
      mapEl = document.createElement("div");
      mapEl.id = "map";
      mapEl.innerHTML = "<canvas></canvas>";
      document.body.appendChild(mapEl);
    });

    afterEach(() => {
      mapEl.remove();
      // Every report marks the start failed (see failStart)
      delete document.body.dataset["startFailure"];
    });

    it("logs the error and replaces the map with a message", () => {
      const error = new Error("no data");

      reportInitFailure(error);

      expect(loggerMock.logError).toHaveBeenCalledWith(error);
      expect(mapEl.innerHTML).toBe(INIT_ERROR_HTML);
      expect(mapEl.querySelector(".init-error")!.textContent).toBe(
        "The map could not start. Reload the page to try again.",
      );
    });

    it("has every control say why, instead of that the flights still load", () => {
      const button = document.createElement("button");
      button.dataset["action"] = "toggleStats";
      button.title = "Statistics";
      document.body.appendChild(button);
      const app = new MapApp(config);
      bindActions(app);

      reportInitFailure(new Error("no map"));
      button.click();

      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.title).toBe(INIT_ERROR_MESSAGE);
      expect(app.store.get("statsPanelVisible")).toBe(false);
      expect(document.querySelector(".toast-notification")!.textContent).toBe(
        INIT_ERROR_MESSAGE,
      );
      app.destroy();
      button.remove();
    });

    it("says why on a press after the app was torn down", () => {
      const button = document.createElement("button");
      button.dataset["action"] = "toggleStats";
      document.body.appendChild(button);
      const app = new MapApp(config);
      bindActions(app);
      // A map that never loaded takes the app's listeners with it
      app.destroy();
      document.getElementById("toast-stack")?.remove();

      reportInitFailure(new Error("no map"));
      button.click();

      expect(document.querySelector(".toast-notification")!.textContent).toBe(
        INIT_ERROR_MESSAGE,
      );
      expect(app.resetViewReason()).toBe(INIT_ERROR_MESSAGE);
      button.remove();
    });

    it("says why for a browser without WebGL 2, as text", async () => {
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

      await initMapApp(config).catch(reportInitFailure);

      const notice = mapEl.querySelector(".init-error")!;
      expect(notice.textContent).toBe(
        "WebGL 2 is not available. Turn on hardware acceleration or try another browser.",
      );
      expect(notice.getAttribute("role")).toBe("alert");
      expect(loggerMock.logError).toHaveBeenCalledWith(
        expect.any(UnsupportedBrowserError),
      );
      window.mapApp?.destroy();
      delete window.mapApp;
    });

    it("still logs when there is no map element", () => {
      mapEl.remove();

      expect(() => reportInitFailure(new Error("boom"))).not.toThrow();
      expect(loggerMock.logError).toHaveBeenCalled();
    });

    it("is what a failed initialization ends in", async () => {
      const error = new Error("init failed");
      vi.spyOn(MapApp.prototype, "initialize").mockRejectedValue(error);

      await initMapApp(config).catch(reportInitFailure);

      expect(loggerMock.logError).toHaveBeenCalledWith(error);
      expect(mapEl.querySelector(".init-error")).not.toBeNull();
      delete window.mapApp;
    });
  });

  describe("destroy", () => {
    it("cancels the deferred Wrapped reopening", () => {
      vi.useFakeTimers();
      const app = new MapApp(config);
      const showWrapped = vi.fn();
      app.wrappedManager = { showWrapped, destroy: vi.fn() } as never;
      app.replayManager = { destroy: vi.fn() } as never;
      app.mobileBar = null;
      app.savedState = { wrappedVisible: true };

      // The reopening is scheduled at the end of initialize(); reproduce
      // only that step so no manager has to be built
      (
        app as unknown as {
          wrappedRestoreTimer: ReturnType<typeof setTimeout> | null;
        }
      ).wrappedRestoreTimer = setTimeout(() => {
        showWrapped();
      }, 500);

      app.destroy();
      vi.advanceTimersByTime(1000);

      expect(showWrapped).not.toHaveBeenCalled();
      expect(
        (app.replayManager as unknown as { destroy: ReturnType<typeof vi.fn> })
          .destroy,
      ).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("takes the safe area's probe along", () => {
      const app = new MapApp(config);
      app.mobileBar = null;
      safeAreaInsets();
      expect(document.getElementById("safe-area-probe")).not.toBeNull();

      app.destroy();

      expect(document.getElementById("safe-area-probe")).toBeNull();
      // A late frame puts no probe back
      safeAreaInsets();
      expect(document.getElementById("safe-area-probe")).toBeNull();
      // A new app measures again
      new MapApp(config).mobileBar = null;
      safeAreaInsets();
      expect(document.getElementById("safe-area-probe")).not.toBeNull();
    });
  });
});
