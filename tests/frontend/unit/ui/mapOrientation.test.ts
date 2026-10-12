import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MapOrientation,
  THREE_D_HINT_MESSAGE,
  THREE_D_TIP_MS,
  THREE_D_TIP_STORAGE_KEY,
} from "../../../../flown/frontend/ui/mapOrientation";
import { HEAT_LINES } from "../../../../flown/frontend/utils/constants";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import {
  asMapApp,
  createMockApp,
  mountElements,
  type MockApp,
} from "../../testHelpers";
import {
  dismissToast,
  showToast,
  type ToastAction,
} from "../../../../flown/frontend/utils/toast";

vi.mock("../../../../flown/frontend/utils/toast", () => ({
  dismissToast: vi.fn(),
  // The toast, which the tip watches the focus of
  showToast: vi.fn(() => document.createElement("div")),
  TOAST_DURATION_MS: 4000,
}));

/**
 * Whether the page is on a touch screen. jsdom has `ontouchstart`, which
 * would make every test one on a touch screen; they start with a mouse.
 */
const device = vi.hoisted(() => ({ touch: false }));
vi.mock("../../../../flown/frontend/utils/device", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../flown/frontend/utils/device")
  >()),
  isTouchDevice: () => device.touch,
}));

describe("MapOrientation", () => {
  let app: MockApp;
  let orientation: MapOrientation;
  let unmount: () => void;

  const compass = (): HTMLElement => document.getElementById("compass-btn")!;
  const floating = (): HTMLElement =>
    document.getElementById("compass-float-btn")!;
  const needle = (button: HTMLElement): string =>
    button.style.getPropertyValue("--compass-turn");

  /** Move the camera and say so the way the map does */
  function turn(camera: { bearing?: number; pitch?: number }): void {
    app.map!.jumpTo(camera);
    if (camera.bearing !== undefined) app.map!.emit("rotate");
    if (camera.pitch !== undefined) app.map!.emit("pitch");
    app.map!.emit("moveend");
  }

  beforeEach(() => {
    // Every test starts on a device that has not had the tip of the 3D
    // view (tests/frontend/setup.ts clears the storage): one that offered
    // or used it stores that, and a test that counts the tip's listeners
    // failed in CI after one that did
    unmount = mountElements({
      // In the document, so the map's canvas can take focus
      map: "div",
      "compass-btn": "button",
      "compass-float-btn": "button",
    });
    floating().hidden = true;
    app = createMockApp();
    orientation = new MapOrientation(asMapApp(app));
  });

  afterEach(() => {
    orientation.destroy();
    unmount();
    device.touch = false;
  });

  describe("compass", () => {
    it("starts pointing up, with the floating one out of the way", () => {
      expect(needle(compass())).toBe("0deg");
      expect(floating().hidden).toBe(true);
    });

    it("points to where north is on a turned map", () => {
      turn({ bearing: 40 });

      // The top of the map is 40 degrees east of north, so north is to its left
      expect(needle(compass())).toBe("-40deg");
      expect(needle(floating())).toBe("-40deg");
      expect(floating().hidden).toBe(false);
    });

    it("shows the floating compass for a map that is only tilted", () => {
      turn({ pitch: 30 });

      expect(needle(compass())).toBe("0deg");
      expect(floating().hidden).toBe(false);
    });

    it("lays the needle back with the map, grown so it stays readable", () => {
      const tilt = (button: HTMLElement): string =>
        button.style.getPropertyValue("--compass-tilt");
      const grow = (button: HTMLElement): number =>
        Number(button.style.getPropertyValue("--compass-grow"));
      // Flat, no 3D transform at all (the stylesheet's fallback)
      expect(tilt(compass())).toBe("");

      turn({ pitch: 60 });

      for (const button of [compass(), floating()]) {
        expect(tilt(button)).toBe("rotateX(60deg)");
        // Half as tall laid back by 60, so it grows by the root of two
        expect(grow(button)).toBeCloseTo(Math.SQRT2, 6);
      }

      // Further back it would lie flat and outgrow its button
      turn({ pitch: 85 });
      expect(tilt(compass())).toBe("rotateX(60deg)");
      expect(grow(compass())).toBeCloseTo(Math.SQRT2, 6);

      turn({ pitch: 0 });
      expect(tilt(compass())).toBe("");
      expect(compass().style.getPropertyValue("--compass-grow")).toBe("");
    });

    it("reads the orientation a link opened the map with", () => {
      orientation.destroy();
      app.map!.jumpTo({ bearing: -120 });

      orientation = new MapOrientation(asMapApp(app));

      expect(needle(compass())).toBe("120deg");
      expect(floating().hidden).toBe(false);
    });

    it("shows the compass unavailable while the map is north up and flat", () => {
      expect(compass().getAttribute("aria-disabled")).toBe("true");
      // The stylesheet dims it from the attribute
      expect(compass().style.opacity).toBe("");

      turn({ bearing: 40 });
      expect(compass().getAttribute("aria-disabled")).toBe("false");

      turn({ bearing: 0, pitch: 30 });
      expect(compass().getAttribute("aria-disabled")).toBe("false");

      turn({ bearing: 0, pitch: 0 });
      expect(compass().getAttribute("aria-disabled")).toBe("true");
    });

    it("turns the map north up and lays it flat", () => {
      turn({ bearing: 40, pitch: 30 });

      orientation.resetNorth();

      expect(app.map!.easeTo).toHaveBeenCalledWith({ bearing: 0, pitch: 0 });
      expect(app.map!.getBearing()).toBe(0);
      expect(app.map!.getPitch()).toBe(0);
    });

    it("hands focus to the map when the floating compass hides under it", () => {
      turn({ bearing: 40 });
      floating().focus();
      expect(document.activeElement).toBe(floating());

      turn({ bearing: 0 });

      expect(floating().hidden).toBe(true);
      expect(document.activeElement).toBe(app.map!.getCanvas());
    });

    it("leaves focus alone when it is somewhere else", () => {
      turn({ bearing: 40 });
      compass().focus();

      turn({ bearing: 0 });

      expect(document.activeElement).toBe(compass());
    });
  });

  describe("globe", () => {
    it("leaves a map that opens in Mercator alone", async () => {
      await app.mapReady;

      expect(app.map!.setProjection).not.toHaveBeenCalled();
    });

    it("switches to the globe and back with the store", async () => {
      await app.mapReady;

      orientation.toggleGlobe();
      expect(app.globeVisible).toBe(true);
      expect(app.map!.getProjection()).toEqual({ type: "globe" });

      orientation.toggleGlobe();
      expect(app.globeVisible).toBe(false);
      expect(app.map!.getProjection()).toEqual({ type: "mercator" });
    });

    it("opens a restored globe as soon as the map has a style", async () => {
      orientation.destroy();
      app = createMockApp({ globeVisible: true });
      orientation = new MapOrientation(asMapApp(app));
      expect(app.map!.setProjection).not.toHaveBeenCalled();

      await app.mapReady;

      expect(app.map!.setProjection).toHaveBeenCalledExactlyOnceWith({
        type: "globe",
      });
    });

    it("waits for the style with a switch made before it has loaded", async () => {
      orientation.destroy();
      let styleLoaded: (map: MockApp["map"]) => void = () => {};
      const mapReady = new Promise<MockApp["map"]>((resolve) => {
        styleLoaded = resolve;
      });
      app = createMockApp({ mapReady });
      orientation = new MapOrientation(asMapApp(app));

      // A projection is part of the style: set earlier, MapLibre throws
      orientation.toggleGlobe();
      expect(app.map!.setProjection).not.toHaveBeenCalled();

      styleLoaded(app.map);
      await mapReady;

      expect(app.map!.getProjection()).toEqual({ type: "globe" });
    });

    it("stays quiet about a map that never got ready", async () => {
      orientation.destroy();
      const failed = Promise.reject(new Error("no layers"));
      app = createMockApp({ mapReady: failed });

      orientation = new MapOrientation(asMapApp(app));

      await expect(failed).rejects.toThrow("no layers");
      expect(app.map!.setProjection).not.toHaveBeenCalled();
    });
  });

  describe("3D", () => {
    beforeEach(() => vi.mocked(showToast).mockClear());

    it("tilts a flat map and leaves the heatmap alone to be lifted as the cloud", () => {
      app.map!.jumpTo({ zoom: 12, pitch: 0 });
      app.heatmapVisible = true;
      app.altitudeVisible = false;
      app.airspeedVisible = false;

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(true);
      expect(app.map!.easeTo).toHaveBeenCalledWith({ pitch: 50 });
      expect(app.uiToggles.toggleAltitude).not.toHaveBeenCalled();
    });

    it("brings the altitude colours on where nothing would be lifted", () => {
      app.heatmapVisible = false;
      app.altitudeVisible = false;
      app.airspeedVisible = false;

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(true);
      // The ribbons are the colour layers lifted, the cloud the heatmap
      expect(app.uiToggles.toggleAltitude).toHaveBeenCalledOnce();
    });

    it("leaves a tilted map and a shown colour layer as they are", () => {
      app.map!.jumpTo({ zoom: 12, pitch: 40 });
      app.airspeedVisible = true;

      orientation.toggleThreeD();

      expect(app.map!.easeTo).not.toHaveBeenCalled();
      expect(app.uiToggles.toggleAltitude).not.toHaveBeenCalled();
    });

    it("puts the flights back on the ground and leaves the map be", () => {
      orientation.toggleThreeD();
      vi.mocked(app.map!.easeTo).mockClear();

      orientation.toggleThreeD();

      expect(app.threeDVisible).toBe(false);
      expect(app.map!.easeTo).not.toHaveBeenCalled();
    });
  });

  describe("the offer of the 3D view", () => {
    beforeEach(() => {
      vi.mocked(showToast).mockClear();
      vi.mocked(dismissToast).mockClear();
    });

    /** Tilt the map to `pitch` and end it as a gesture or `eventData` does */
    function tilt(pitch: number, eventData: object = {}): void {
      app.map!.jumpTo({ pitch });
      app.map!.emit("pitchend", eventData);
    }
    const byHand = { originalEvent: new MouseEvent("mouseup") };
    const offers = (): unknown[][] =>
      vi
        .mocked(showToast)
        .mock.calls.filter(([message]) => message === THREE_D_HINT_MESSAGE);

    it("comes once a visit, as a flat map is tilted by hand past 30 degrees", () => {
      tilt(25, byHand);
      expect(offers()).toHaveLength(0);

      tilt(35, byHand);
      expect(offers()).toHaveLength(1);
      expect(offers()[0]![1]).toBe("info");

      tilt(0, byHand);
      tilt(40, byHand);
      expect(offers()).toHaveLength(1);
      // Asked for by the tilt, it stays until it is dismissed
      expect(app.map!.listenerCount("movestart")).toBe(0);
    });

    it("comes from a smaller tilt on a touch screen, where the gesture is", () => {
      device.touch = true;
      tilt(10, byHand);
      expect(offers()).toHaveLength(0);

      tilt(16, byHand);
      expect(offers()).toHaveLength(1);
    });

    it("does not come for the app's own camera moves", () => {
      tilt(50);
      tilt(50, REPLAY_CAMERA_MOVE);
      expect(offers()).toHaveLength(0);
    });

    it("does not come in the 3D view, a replay, Wrapped or the tour, nor once 3D was switched on", () => {
      for (const key of ["replayActive", "wrappedVisible"] as const) {
        app[key] = true;
        tilt(45, byHand);
        app[key] = false;
      }
      app.tourView = {} as MockApp["tourView"];
      tilt(45, byHand);
      app.tourView = null;
      app.threeDVisible = true;
      tilt(45, byHand);
      app.threeDVisible = false;
      orientation.toggleThreeD();
      tilt(45, byHand);
      orientation.toggleThreeD();
      tilt(45, byHand);
      expect(offers()).toHaveLength(0);
    });

    it("still comes once the 3D view the tour turned on is off again", () => {
      app.threeDVisible = true;
      app.threeDVisible = false;
      tilt(45, byHand);
      expect(offers()).toHaveLength(1);
    });

    it("turns the 3D view on as the 3D button does, and goes when 3D comes on", () => {
      tilt(45, byHand);
      const action = offers()[0]![2] as ToastAction;
      expect(action.label).toBe("3D");

      action.run();
      expect(app.threeDVisible).toBe(true);
      expect(dismissToast).toHaveBeenCalledWith(THREE_D_HINT_MESSAGE);
      // Run again with the 3D view on, it leaves it on
      action.run();
      expect(app.threeDVisible).toBe(true);
    });

    it("goes when the 3D view comes on another way", () => {
      tilt(45, byHand);
      app.threeDVisible = true;
      expect(dismissToast).toHaveBeenCalledWith(THREE_D_HINT_MESSAGE);
    });

    it("lets go of the store and the map when destroyed", () => {
      orientation.destroy();
      tilt(45, byHand);
      app.threeDVisible = true;
      expect(offers()).toHaveLength(0);
      expect(dismissToast).not.toHaveBeenCalled();
    });

    describe("as a tip on a touch screen", () => {
      const map = (): NonNullable<MockApp["map"]> => app.map!;
      /** Short of the heat lines, and among them */
      const below = HEAT_LINES.midZoom - 1;
      const among = HEAT_LINES.fullZoom;
      /** The map comes to rest at `level`, as after a move of the app's */
      function rest(level: number): void {
        map().jumpTo({ zoom: level });
        map().emit("moveend", {});
      }
      /**
       * A zoom to `level` from where the map rests, started and ended as a
       * gesture or `eventData` does, and at rest there
       */
      function pinch(level: number, eventData: object = byHand): void {
        map().emit("zoomstart", eventData);
        map().jumpTo({ zoom: level });
        map().emit("zoomend", eventData);
        map().emit("moveend", eventData);
      }
      let nextId = 100;
      /**
       * Select `ids`, and let the tip weigh the change, which it does once
       * whatever made it has run (an airport opens its popup after)
       */
      async function select(ids: Iterable<number>): Promise<void> {
        app.selectedPathIds = new Set(ids);
        await Promise.resolve();
      }
      /** One flight more in the selection, as a tap or a list adds it */
      const pick = (): Promise<void> =>
        select([...app.selectedPathIds, nextId++]);
      /** The next visit on the same device */
      function revisit(
        overrides: Parameters<typeof createMockApp>[0] = {},
      ): void {
        orientation.destroy();
        app = createMockApp(overrides);
        orientation = new MapOrientation(asMapApp(app));
        rest(below);
      }

      beforeEach(() => {
        // On a touch screen from the start, where the tip listens
        device.touch = true;
        revisit();
      });

      it("comes as a zoom in by hand crosses into the heat lines, once on the device", async () => {
        pinch(HEAT_LINES.midZoom - 0.5);
        // The app's own moves: a link, Reset view, the replay's camera
        rest(below);
        pinch(among, {});
        rest(below);
        pinch(among, REPLAY_CAMERA_MOVE);
        expect(offers()).toHaveLength(0);

        rest(below);
        pinch(HEAT_LINES.midZoom);
        expect(offers()).toHaveLength(1);
        expect(localStorage.getItem(THREE_D_TIP_STORAGE_KEY)).toBe("1");
        rest(below);
        pinch(among);
        await pick();
        expect(offers()).toHaveLength(1);

        // Still the one of the first visit
        revisit();
        pinch(among);
        await pick();
        expect(offers()).toHaveLength(1);
      });

      it("does not come for a zoom out, nor a pinch among the lines", () => {
        rest(among + 1);
        pinch(HEAT_LINES.midZoom);
        pinch(among + 2);
        expect(offers()).toHaveLength(0);
      });

      it("measures from rest to rest, the glide of a pinch included", () => {
        // The pinch lets go short of the lines, and its glide carries over
        map().emit("zoomstart", byHand);
        map().jumpTo({ zoom: HEAT_LINES.midZoom - 0.1 });
        map().emit("zoomend", byHand);
        map().emit("zoomstart", byHand);
        map().jumpTo({ zoom: HEAT_LINES.midZoom + 0.1 });
        map().emit("zoomend", byHand);
        expect(offers()).toHaveLength(0);

        map().emit("moveend", byHand);
        expect(offers()).toHaveLength(1);
      });

      it("waits for the map to rest when a pinch turns into a pan", () => {
        map().emit("zoomstart", byHand);
        map().jumpTo({ zoom: among });
        map().emit("zoomend", byHand);
        // Still moving under one finger
        expect(offers()).toHaveLength(0);

        map().emit("moveend", byHand);
        expect(offers()).toHaveLength(1);
      });

      it("does not come for a zoom while the app starts", () => {
        app.isInitializing = true;
        pinch(among);
        expect(offers()).toHaveLength(0);
        app.isInitializing = false;
        rest(below);
        pinch(among);
        expect(offers()).toHaveLength(1);
      });

      it("comes as the first flight is picked, and the 3D button turns 3D on", async () => {
        await select([]);
        expect(offers()).toHaveLength(0);

        await pick();

        expect(offers()).toHaveLength(1);
        const action = offers()[0]![2] as ToastAction;
        expect(action.label).toBe("3D");
        action.run();
        expect(app.threeDVisible).toBe(true);
      });

      it("comes for one flight that comes in, not an airport's flights nor one taken out", async () => {
        // A link's flights, put back before the app listens
        revisit({ selectedPathIds: new Set([1, 2]) });
        // A load that trims it, or a flight taken out
        await select([1]);
        // An airport's flights, whose popup the tip would cover
        await select([1, 5, 6, 7]);
        expect(offers()).toHaveLength(0);

        // Another flight picked in their place
        await select([8]);
        expect(offers()).toHaveLength(1);
      });

      it("does not come for an airport flown to once, whose popup opens after", async () => {
        const popup = vi.mocked(app.airportManager.isPopupOpen);
        // Selected first, the popup opened right after (activateAirport)
        app.selectedPathIds = new Set([nextId++]);
        popup.mockReturnValue(true);
        await Promise.resolve();
        // Nor a flight picked from that popup while it stays open
        await pick();
        expect(offers()).toHaveLength(0);
        expect(localStorage.getItem(THREE_D_TIP_STORAGE_KEY)).toBeNull();

        popup.mockReturnValue(false);
        await pick();
        expect(offers()).toHaveLength(1);
      });

      it("does not come over the phone's statistics sheet, but with a later pick", async () => {
        const sheet = { isVisible: vi.fn(() => true) };
        app.mobileBar = sheet as unknown as MockApp["mobileBar"];
        app.statsPanelVisible = true;
        // A flight ticked in one of its lists
        await pick();
        expect(offers()).toHaveLength(0);
        expect(localStorage.getItem(THREE_D_TIP_STORAGE_KEY)).toBeNull();

        app.statsPanelVisible = false;
        await pick();
        expect(offers()).toHaveLength(1);
      });

      it("does not come for the selection put back at start", async () => {
        app.isInitializing = true;
        await pick();
        expect(offers()).toHaveLength(0);
      });

      it("does not come with a mouse, which keeps the offer of the tilt alone", async () => {
        device.touch = false;
        revisit();
        pinch(among);
        await pick();
        expect(offers()).toHaveLength(0);
        expect(localStorage.getItem(THREE_D_TIP_STORAGE_KEY)).toBeNull();
      });

      it("does not come during a replay, Wrapped or the tour, which leave it for later", async () => {
        for (const key of ["replayActive", "wrappedVisible"] as const) {
          app[key] = true;
          await pick();
          app[key] = false;
        }
        // The tour turns 3D on for its flight, and back off after
        app.tourView = {} as MockApp["tourView"];
        app.threeDVisible = true;
        await pick();
        app.threeDVisible = false;
        app.tourView = null;
        expect(offers()).toHaveLength(0);
        expect(localStorage.getItem(THREE_D_TIP_STORAGE_KEY)).toBeNull();

        await pick();
        expect(offers()).toHaveLength(1);
      });

      it("does not come where a link opened in 3D, but on the next visit", () => {
        revisit({ threeDVisible: true });
        app.threeDVisible = false;
        pinch(among);
        expect(offers()).toHaveLength(0);

        revisit();
        pinch(among);
        expect(offers()).toHaveLength(1);
      });

      it("does not come on a device whose user switched 3D on", () => {
        orientation.toggleThreeD();
        orientation.toggleThreeD();

        revisit();
        pinch(among);
        expect(offers()).toHaveLength(0);
      });

      it("does not come on a device whose user switched off the 3D view a link turned on", async () => {
        revisit({ threeDVisible: true });
        orientation.toggleThreeD();
        expect(app.threeDVisible).toBe(false);
        expect(localStorage.getItem(THREE_D_TIP_STORAGE_KEY)).toBe("1");
        await pick();
        pinch(among);
        expect(offers()).toHaveLength(0);

        revisit();
        await pick();
        expect(offers()).toHaveLength(0);
      });

      it("comes once a visit where the browser keeps nothing", async () => {
        const fail = (): never => {
          throw new DOMException("denied", "SecurityError");
        };
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(fail);
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(fail);
        pinch(among);
        await pick();
        expect(offers()).toHaveLength(1);

        revisit();
        pinch(among);
        expect(offers()).toHaveLength(2);
      });

      describe("going by itself", () => {
        beforeEach(() => {
          vi.useFakeTimers();
        });

        afterEach(() => {
          vi.useRealTimers();
        });

        it("goes after a while, or once the map is moved by hand", async () => {
          await pick();
          expect(offers()).toHaveLength(1);
          vi.advanceTimersByTime(THREE_D_TIP_MS - 1);
          expect(dismissToast).not.toHaveBeenCalled();
          vi.advanceTimersByTime(1);
          expect(dismissToast).toHaveBeenCalledWith(THREE_D_HINT_MESSAGE);
          expect(map().listenerCount("movestart")).toBe(0);

          vi.mocked(dismissToast).mockClear();
          localStorage.clear();
          revisit();
          await pick();
          // The app's own moves leave it, such as framing the flight
          map().emit("movestart", {});
          expect(dismissToast).not.toHaveBeenCalled();
          map().emit("movestart", byHand);
          expect(dismissToast).toHaveBeenCalledOnce();
          // Nothing is left to take it away twice
          vi.advanceTimersByTime(THREE_D_TIP_MS);
          expect(dismissToast).toHaveBeenCalledOnce();
          expect(map().listenerCount("movestart")).toBe(0);
        });

        it("stays while the focus is on it, and goes a while after it left", async () => {
          const toast = document.createElement("div");
          const button = document.createElement("button");
          toast.append(button);
          document.body.append(toast);
          vi.mocked(showToast).mockReturnValueOnce(toast);
          try {
            await pick();
            button.focus();
            vi.advanceTimersByTime(THREE_D_TIP_MS);
            map().emit("movestart", byHand);
            expect(dismissToast).not.toHaveBeenCalled();
            expect(document.activeElement).toBe(button);

            button.blur();
            vi.advanceTimersByTime(THREE_D_TIP_MS - 1);
            expect(dismissToast).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(dismissToast).toHaveBeenCalledWith(THREE_D_HINT_MESSAGE);
          } finally {
            toast.remove();
          }
        });

        it("leaves nothing to take it away once 3D is on or the app goes", async () => {
          await pick();
          expect(map().listenerCount("movestart")).toBe(1);
          orientation.toggleThreeD();
          expect(map().listenerCount("movestart")).toBe(0);

          localStorage.clear();
          revisit();
          await pick();
          orientation.destroy();
          expect(map().listenerCount("movestart")).toBe(0);
          vi.advanceTimersByTime(THREE_D_TIP_MS);
          expect(dismissToast).toHaveBeenCalledOnce();
        });
      });

      it("stops listening for its moments once offered or once 3D is switched on", async () => {
        // Its own and the globe's (onMoveEnd)
        expect(map().listenerCount("zoomstart")).toBe(1);
        expect(map().listenerCount("moveend")).toBe(2);
        await pick();
        expect(offers()).toHaveLength(1);
        expect(map().listenerCount("zoomstart")).toBe(0);
        expect(map().listenerCount("moveend")).toBe(1);

        localStorage.clear();
        revisit();
        expect(map().listenerCount("zoomstart")).toBe(1);
        orientation.toggleThreeD();
        expect(map().listenerCount("zoomstart")).toBe(0);
      });

      it("does not listen on a device that had it", async () => {
        await pick();
        revisit();
        expect(map().listenerCount("zoomstart")).toBe(0);
      });

      it("stops listening for its moments when destroyed", async () => {
        orientation.destroy();
        expect(map().listenerCount("zoomstart")).toBe(0);
        pinch(among);
        await pick();
        expect(offers()).toHaveLength(0);
      });

      it("does not come for a pick weighed after the app went or 3D was switched", async () => {
        // The pick is weighed a microtask later, by when either has come
        app.selectedPathIds = new Set([nextId++]);
        orientation.destroy();
        await Promise.resolve();
        expect(offers()).toHaveLength(0);

        revisit();
        app.selectedPathIds = new Set([nextId++]);
        orientation.toggleThreeD();
        orientation.toggleThreeD();
        await Promise.resolve();
        expect(offers()).toHaveLength(0);
      });
    });
  });

  describe("a focused marker that goes behind the globe", () => {
    let marker: HTMLButtonElement;

    /** The frame after a move, in which MapLibre has marked the markers */
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));

    beforeEach(() => {
      orientation.destroy();
      marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      document.body.append(marker);
      app = createMockApp({ globeVisible: true });
      orientation = new MapOrientation(asMapApp(app));
      marker.focus();
    });

    afterEach(() => marker.remove());

    it("hands its focus to the map, so the keys go on turning the globe", async () => {
      app.map!.emit("moveend");
      await nextFrame();
      expect(document.activeElement).toBe(marker);

      // What MapLibre does to a marker on the far side, a frame after the
      // move; the stylesheet hides it only once it has lost the focus
      app.map!.emit("moveend");
      marker.classList.add("maplibregl-marker-covered");
      await nextFrame();

      expect(document.activeElement).toBe(app.map!.getCanvas());
    });

    it("takes focus from inside a marker as well", async () => {
      const inner = document.createElement("button");
      marker.append(inner);
      inner.focus();
      marker.classList.add("maplibregl-marker-covered");

      app.map!.emit("moveend");
      await nextFrame();

      expect(document.activeElement).toBe(app.map!.getCanvas());
    });

    it("leaves focus that is somewhere else alone", async () => {
      marker.classList.add("maplibregl-marker-covered");
      compass().focus();

      app.map!.emit("moveend");
      await nextFrame();

      expect(document.activeElement).toBe(compass());
    });

    it("does not look at every frame of the replay's camera", async () => {
      marker.classList.add("maplibregl-marker-covered");

      app.map!.emit("moveend", REPLAY_CAMERA_MOVE);
      await nextFrame();

      expect(document.activeElement).toBe(marker);
    });

    it("does not look on a flat map, where nothing is ever behind", async () => {
      app.globeVisible = false;
      marker.classList.add("maplibregl-marker-covered");

      app.map!.emit("moveend");
      await nextFrame();

      expect(document.activeElement).toBe(marker);
    });
  });

  describe("teardown", () => {
    it("stops listening to the map", () => {
      // On a touch screen, where the tip of the 3D view listens as well
      device.touch = true;
      orientation.destroy();
      orientation = new MapOrientation(asMapApp(app));
      // `moveend` twice: the globe's marker focus and the tip's moments
      const types = ["rotate", "pitch", "moveend", "pitchend", "zoomstart"];
      for (const type of types) {
        expect(app.map!.listenerCount(type)).toBe(type === "moveend" ? 2 : 1);
      }

      orientation.destroy();

      for (const type of types) {
        expect(app.map!.listenerCount(type)).toBe(0);
      }
    });

    it("does nothing without a map", () => {
      const mapless = createMockApp({ map: null });

      const idle = new MapOrientation(asMapApp(mapless));

      expect(() => idle.resetNorth()).not.toThrow();
      expect(() => idle.destroy()).not.toThrow();
    });
  });
});
