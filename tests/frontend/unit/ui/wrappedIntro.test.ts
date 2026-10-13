/**
 * Wrapped's intro: the storyboard and its timing, the replay of all
 * flights under it, the ways it is skipped, reduced motion, the switches it
 * changes and puts back, its preparation from the button, and the
 * destinations the map flies to afterwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetSiteData } from "../../../../flown/frontend/state/siteData";
import {
  INTRO_SEEN_KEY,
  WrappedManager,
} from "../../../../flown/frontend/ui/wrappedManager";
import {
  FIT_PADDING,
  INTRO_FLY_MS,
  INTRO_SETTLE_MS,
  INTRO_TURN_MS,
  INTRO_WAIT_MS,
  overviewBounds,
  prepareWrappedIntro,
} from "../../../../flown/frontend/ui/wrappedIntro";
import * as cameraScript from "../../../../flown/frontend/ui/cameraScript";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import * as motion from "../../../../flown/frontend/utils/motion";
import { asMapApp, type MockApp } from "../../testHelpers";
import {
  createWrappedMockApp,
  el,
  installAirports,
  mountWrappedDom,
} from "./wrappedTestSetup";

/**
 * The feature bundle, with a stand-in for the player of replay-all that
 * notes every one made: it plays as long as it has a flight to
 * (`flightsToPlay`)
 */
const features = vi.hoisted(() => {
  class ReplayAllPlayer {
    static made: ReplayAllPlayer[] = [];
    static flightsToPlay = 3;
    active = false;
    readonly start = vi.fn((_run: object) => {
      this.active = ReplayAllPlayer.flightsToPlay > 0;
      return new Promise<boolean>(() => {});
    });
    readonly stop = vi.fn(() => {
      this.active = false;
    });
    constructor(readonly app: unknown) {
      ReplayAllPlayer.made.push(this);
    }
  }
  return {
    followHeatCloud: vi.fn(),
    prepareHeatCloud: vi.fn(),
    ReplayAllPlayer,
  };
});
const loader = vi.hoisted(() => ({
  loadFeatures: vi.fn(() => Promise.resolve(features as unknown)),
}));
vi.mock(
  "../../../../flown/frontend/services/featureLoader",
  async (original) => ({
    ...(await original<object>()),
    loadFeatures: loader.loadFeatures,
  }),
);

// The camera moves the intro finds in the bundle are the real ones
Object.assign(features, cameraScript);

/** The dialog moves the map in and measures it this long after opening */
const MAP_IN_DIALOG_MS = 150;

/** Frankfurt, the home base of the 2024 flights of the history */
const HOME: [number, number] = [8.57, 50.03];

/** A view of the map without padding */
const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

describe("Wrapped's intro", () => {
  let wrappedManager: WrappedManager;
  let mockApp: MockApp;

  const map = (): NonNullable<MockApp["map"]> => mockApp.map!;
  const modal = (): HTMLElement => el("wrapped-modal");
  const skipButton = (): HTMLElement => el("wrapped-skip-btn");
  const mapPanel = (): HTMLElement => el("wrapped-map-container");
  const column = (): HTMLElement => el("wrapped-cards-column");

  beforeEach(() => {
    vi.useFakeTimers();
    installAirports();
    mountWrappedDom();
    mockApp = createWrappedMockApp();
    // Nothing to wait for: the map reveals itself at once
    map().loaded.mockReturnValue(true);
    features.followHeatCloud.mockClear();
    features.prepareHeatCloud.mockClear();
    features.ReplayAllPlayer.made = [];
    features.ReplayAllPlayer.flightsToPlay = 3;
    loader.loadFeatures.mockClear();
    loader.loadFeatures.mockImplementation(() =>
      Promise.resolve(features as unknown),
    );
    wrappedManager = new WrappedManager(asMapApp(mockApp));
  });

  afterEach(() => {
    wrappedManager.destroy();
    vi.useRealTimers();
    document.body.innerHTML = "";
    resetSiteData();
  });

  /** Open from the button and let the map into the dialog */
  async function openWithIntro(): Promise<void> {
    // As a first opening in the session, which is the one that plays it
    sessionStorage.removeItem(INTRO_SEEN_KEY);
    wrappedManager.showWrapped(true);
    await vi.advanceTimersByTimeAsync(MAP_IN_DIALOG_MS);
  }

  /** The last call of a camera move, options and event data */
  function lastMove(
    move: "jumpTo" | "flyTo" | "easeTo" | "fitBounds",
  ): unknown[] | undefined {
    return map()[move].mock.lastCall;
  }

  it("plays from the button: titled and far out on the globe, the flight home, the turn, then the overview and the cards", async () => {
    map().setZoom(5.5);
    wrappedManager.showWrapped(true);
    // Cards held back, the map shaded under the title of the year, Skip
    // on offer
    expect(modal().classList.contains("is-intro")).toBe(true);
    expect(mapPanel().classList.contains("is-dark")).toBe(true);
    expect(skipButton().hidden).toBe(false);
    // Out of the tab order under the map as well, side by side too
    expect(column().hasAttribute("inert")).toBe(true);
    expect(el("wrapped-intro-heading").textContent).toBe(
      el("wrapped-title").textContent,
    );
    expect(el("wrapped-intro-year").textContent).toBe("2024");
    expect(map().fitBounds).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MAP_IN_DIALOG_MS);
    // The cloud without the 3D view, on the globe
    expect(features.followHeatCloud).toHaveBeenCalledWith(mockApp);
    expect(mockApp.store.get("forcedHeatCloud")).toBe(true);
    expect(mockApp.store.get("globeVisible")).toBe(true);
    expect(mockApp.store.get("threeDVisible")).toBe(false);
    // On the overview first, untagged, which the cloud is cut for; then
    // far out, tagged
    const [overview, far] = map().jumpTo.mock.calls;
    expect(overview).toEqual([
      expect.objectContaining({ bearing: 0, pitch: 0, zoom: 5.5 }),
    ]);
    const [farView, farTag] = far!;
    expect(farView).toMatchObject({ zoom: 1.2, pitch: 0, bearing: 0 });
    expect(farTag).toBe(REPLAY_CAMERA_MOVE);
    expect(map().padding).toEqual(NO_PADDING);

    // The far view drawn, the camera flies home and the shade lifts: two
    // levels closer than the overview, tilted
    const [fly, flyTag] = lastMove("flyTo")!;
    expect(fly).toMatchObject({
      center: HOME,
      zoom: 7.5,
      pitch: 45,
      duration: INTRO_FLY_MS,
    });
    expect(flyTag).toBe(REPLAY_CAMERA_MOVE);
    expect(mapPanel().classList.contains("is-dark")).toBe(false);
    expect(modal().classList.contains("is-intro")).toBe(true);

    // Then it turns slowly over home
    expect(map().easeTo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTRO_FLY_MS);
    const [turn, turnTag] = lastMove("easeTo")!;
    expect(turn).toMatchObject({ duration: INTRO_TURN_MS });
    expect((turn as { bearing: number }).bearing).toBeGreaterThan(
      (fly as { bearing: number }).bearing,
    );
    expect(turnTag).toBe(REPLAY_CAMERA_MOVE);

    // And settles on the overview, untagged, as the cards come in
    const measured = map().resize.mock.calls.length;
    await vi.advanceTimersByTimeAsync(INTRO_TURN_MS);
    expect(map().easeTo).toHaveBeenCalledTimes(2);
    const [settle, settleTag] = lastMove("easeTo")!;
    expect(settle).toMatchObject({
      bearing: 0,
      pitch: 0,
      duration: INTRO_SETTLE_MS,
    });
    expect(settleTag).toBeUndefined();
    expect(modal().classList.contains("is-intro")).toBe(false);
    expect(modal().classList.contains("is-settling")).toBe(true);
    expect(skipButton().hidden).toBe(true);
    expect(column().hasAttribute("inert")).toBe(false);
    expect(map().resize.mock.calls.length).toBe(measured);
    // Onto the flat heatmap and the projection of before as it sets off,
    // which the camera settles in: the overview a skip shows, and a
    // heatmap MapLibre draws anew at every zoom of a flight to a
    // destination
    expect(mockApp.store.get("forcedHeatCloud")).toBe(false);
    expect(mockApp.store.get("globeVisible")).toBe(false);

    // Where it is measured in its panel and fitted to it once there
    await vi.advanceTimersByTimeAsync(INTRO_SETTLE_MS);
    expect(modal().classList.contains("is-settling")).toBe(false);
    expect(map().resize.mock.calls.length).toBe(measured + 1);
    expect(map().fitBounds).toHaveBeenCalledOnce();
    expect(lastMove("fitBounds")![1]).toMatchObject({
      bearing: 0,
      pitch: 0,
      animate: false,
    });
    expect(map().padding).toEqual(NO_PADDING);
    // Beside the cards the flat heatmap on the projection of before, as
    // after a skip: the cloud and the globe were the intro's
    expect(mockApp.store.get("forcedHeatCloud")).toBe(false);
    expect(mockApp.store.get("globeVisible")).toBe(false);

    // Nothing more moves the camera
    await vi.runAllTimersAsync();
    expect(map().fitBounds).toHaveBeenCalledOnce();
    expect(map().easeTo).toHaveBeenCalledTimes(2);
  });

  it("comes down no closer than zoom 9 over home", async () => {
    map().setZoom(8);
    await openWithIntro();
    expect(lastMove("flyTo")![0]).toMatchObject({ zoom: 9 });
  });

  it("fits the overview with the cloud and the globe on, so the end of that zoom cuts nothing for the relief the globe leaves out", async () => {
    const seen: unknown[] = [];
    map().jumpTo.mockImplementation((_options, eventData) => {
      if (!eventData) {
        seen.push([
          mockApp.store.get("forcedHeatCloud"),
          mockApp.store.get("globeVisible"),
        ]);
      }
      return map();
    });
    await openWithIntro();
    expect(seen).toEqual([[true, true]]);
  });

  it("puts the user's globe, 3D view and view back as the dialog closes", async () => {
    mockApp.store.set("threeDVisible", true);
    map().setZoom(11);
    await openWithIntro();
    expect(wrappedManager.userMapView()).toMatchObject({
      zoom: 11,
      globeVisible: false,
      threeDVisible: true,
    });

    // Closed as it settles, with the map's view padded for the cards
    await vi.advanceTimersByTimeAsync(INTRO_FLY_MS + INTRO_TURN_MS);
    expect(modal().classList.contains("is-settling")).toBe(true);
    wrappedManager.closeWrapped();
    expect(modal().classList.contains("is-settling")).toBe(false);
    expect(map().padding).toEqual(NO_PADDING);
    expect(mockApp.store.get("globeVisible")).toBe(false);
    expect(mockApp.store.get("threeDVisible")).toBe(true);
    expect(mockApp.store.get("forcedHeatCloud")).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(lastMove("jumpTo")![0]).toMatchObject({ zoom: 11 });
    expect(wrappedManager.userMapView()).toBeNull();
    // Nor does the end of the settle move it any more
    await vi.runAllTimersAsync();
    expect(lastMove("jumpTo")![0]).toMatchObject({ zoom: 11 });
    expect(map().fitBounds).not.toHaveBeenCalled();
  });

  it("sets off as soon as the tiles of the far globe are drawn, before its labels have faded in", async () => {
    map().loaded.mockReturnValue(false);
    map().areTilesLoaded.mockReturnValue(false);
    await openWithIntro();
    const renders = map().listenerCount("render");
    expect(mapPanel().classList.contains("is-awaiting-map")).toBe(true);

    map().emit("render");
    await Promise.resolve();
    expect(mapPanel().classList.contains("is-awaiting-map")).toBe(true);
    expect(map().flyTo).not.toHaveBeenCalled();

    map().areTilesLoaded.mockReturnValue(true);
    map().emit("render");
    // The wait settles (whenMapComplete), and the reveal follows it
    await Promise.resolve();
    expect(mapPanel().classList.contains("is-awaiting-map")).toBe(false);
    expect(map().flyTo).toHaveBeenCalledOnce();
    expect(map().listenerCount("render")).toBe(renders - 1);
  });

  it("stops where it is when the dialog closes while it plays", async () => {
    await openWithIntro();
    wrappedManager.closeWrapped();

    expect(map().stop).toHaveBeenCalled();
    expect(mockApp.store.get("globeVisible")).toBe(false);
    expect(mockApp.store.get("forcedHeatCloud")).toBe(false);
    expect(modal().classList.contains("is-intro")).toBe(false);
    await vi.runAllTimersAsync();
    // Neither the turn nor the settle
    expect(map().easeTo).not.toHaveBeenCalled();
    expect(map().fitBounds).not.toHaveBeenCalled();
  });

  describe("skipped", () => {
    it("by new data, and comes to rest on the overview of that", async () => {
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS / 2);
      const opened = overviewBounds(asMapApp(mockApp));

      // A year that finished loading: the intro played the flights of
      // before, and settled on their overview
      const history = mockApp.currentData!;
      mockApp.currentData = {
        ...history,
        path_info: history.path_info.slice(0, 1),
        path_segments: history.path_segments.filter(
          (segment) => segment.path_id === history.path_info[0]!.id,
        ),
      };

      expect(skipButton().hidden).toBe(true);
      expect(mockApp.store.get("globeVisible")).toBe(false);
      expect(map().fitBounds).toHaveBeenCalledTimes(1);
      const refitted = lastMove("fitBounds")![0];
      expect(refitted).toEqual(overviewBounds(asMapApp(mockApp)));
      expect(refitted).not.toEqual(opened);
    });

    /** Wrapped as it opens without the intro */
    function expectWrappedAsToday(): void {
      expect(modal().classList.contains("is-intro")).toBe(false);
      expect(modal().classList.contains("is-settling")).toBe(false);
      expect(mapPanel().classList.contains("is-dark")).toBe(false);
      expect(skipButton().hidden).toBe(true);
      expect(mockApp.store.get("globeVisible")).toBe(false);
      expect(mockApp.store.get("forcedHeatCloud")).toBe(false);
      expect(lastMove("fitBounds")![1]).toMatchObject({
        bearing: 0,
        pitch: 0,
        animate: false,
      });
    }

    it("by its button, opens Wrapped as it opens without it, at once", async () => {
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS / 2);
      skipButton().focus();
      const measured = map().resize.mock.calls.length;
      skipButton().click();

      expect(map().stop).toHaveBeenCalled();
      expectWrappedAsToday();
      // The map keeps showing: a fade-in that started over from its delay
      // left the panel empty for a moment
      expect(modal().classList.contains("has-intro")).toBe(true);
      // Measured with the cards back in, before the fit: stacked, the map
      // had the dialog to itself
      expect(map().resize.mock.calls.length).toBe(measured + 1);
      expect(map().resize.mock.invocationCallOrder.at(-1)!).toBeLessThan(
        map().fitBounds.mock.invocationCallOrder.at(-1)!,
      );
      // Focus does not drop to the page behind the dialog
      expect(document.activeElement).toBe(modal().querySelector(".close-btn"));
      await vi.runAllTimersAsync();
      expect(map().easeTo).not.toHaveBeenCalled();
    });

    it("by a press, a wheel or a key on the map, which takes over", async () => {
      for (const type of ["pointerdown", "wheel", "keydown"]) {
        await openWithIntro();
        map().getContainer().dispatchEvent(new Event(type));
        expectWrappedAsToday();
        wrappedManager.closeWrapped();
        await vi.runAllTimersAsync();
      }
      // A press once it has ended leaves the map alone
      const fits = map().fitBounds.mock.calls.length;
      map().getContainer().dispatchEvent(new Event("pointerdown"));
      expect(map().fitBounds.mock.calls.length).toBe(fits);
    });

    it("not by Tab or Shift, which move on through the dialog", async () => {
      await openWithIntro();
      for (const key of ["Tab", "Shift"]) {
        map()
          .getContainer()
          .dispatchEvent(new KeyboardEvent("keydown", { key }));
      }

      expect(modal().classList.contains("is-intro")).toBe(true);
      expect(skipButton().hidden).toBe(false);
    });

    it("when the heat cloud's code does not come in time", async () => {
      loader.loadFeatures.mockImplementation(() => new Promise(() => {}));
      await openWithIntro();
      expect(modal().classList.contains("is-intro")).toBe(true);

      await vi.advanceTimersByTimeAsync(INTRO_WAIT_MS);
      expectWrappedAsToday();
      expect(map().jumpTo).not.toHaveBeenCalled();
      expect(map().flyTo).not.toHaveBeenCalled();
      expect(mapPanel().classList.contains("is-awaiting-map")).toBe(false);
    });

    it("when the heat cloud's code fails as it arrives", async () => {
      features.followHeatCloud.mockImplementationOnce(() => {
        throw new Error("no cloud");
      });
      await openWithIntro();

      expectWrappedAsToday();
      expect(map().flyTo).not.toHaveBeenCalled();
      expect(mapPanel().classList.contains("is-awaiting-map")).toBe(false);
    });
  });

  it("leaves the map alone once the dialog is torn down while the intro waits", async () => {
    let arrive: (module: unknown) => void = () => {};
    loader.loadFeatures.mockImplementation(
      () => new Promise((resolve) => (arrive = resolve)),
    );
    await openWithIntro();
    // A map still busy would be waited for
    map().loaded.mockReturnValue(false);
    wrappedManager.destroy();
    arrive(features);
    await vi.runAllTimersAsync();

    expect(map().jumpTo).not.toHaveBeenCalled();
    expect(map().flyTo).not.toHaveBeenCalled();
    expect(map().on).not.toHaveBeenCalledWith("idle", expect.anything());
  });

  it("does not play under reduced motion: Wrapped opens as it does without it", async () => {
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
    await openWithIntro();

    expect(modal().classList.contains("is-intro")).toBe(false);
    expect(skipButton().hidden).toBe(true);
    expect(loader.loadFeatures).not.toHaveBeenCalled();
    expect(mockApp.store.get("globeVisible")).toBe(false);
    expect(mockApp.store.get("forcedHeatCloud")).toBe(false);
    expect(map().flyTo).not.toHaveBeenCalled();
    expect(features.ReplayAllPlayer.made).toHaveLength(0);
    expect(map().fitBounds).toHaveBeenCalledTimes(2);
    expect(lastMove("fitBounds")![1]).toMatchObject({ animate: false });
  });

  it("does not play for a dialog opened other than by its button, nor without a home base", async () => {
    // A restored state reopens it
    wrappedManager.showWrapped();
    expect(modal().classList.contains("is-intro")).toBe(false);
    expect(modal().classList.contains("has-intro")).toBe(false);
    wrappedManager.closeWrapped();
    await vi.runAllTimersAsync();

    mockApp.selectedYear = "1999";
    wrappedManager.showWrapped(true);
    expect(modal().classList.contains("is-intro")).toBe(false);
    expect(loader.loadFeatures).not.toHaveBeenCalled();
    // Not played, so not seen: it plays once the year has a home base
    expect(sessionStorage.getItem(INTRO_SEEN_KEY) ?? "").not.toContain("1999");
  });

  it("plays once a session for each year, and again where the storage is blocked", async () => {
    const opens = async (year: string): Promise<boolean> => {
      mockApp.selectedYear = year;
      wrappedManager.showWrapped(true);
      const intro = modal().classList.contains("has-intro");
      // Seen once it begins, with the map in the dialog
      await vi.advanceTimersByTimeAsync(MAP_IN_DIALOG_MS);
      wrappedManager.closeWrapped();
      await vi.runAllTimersAsync();
      return intro;
    };

    expect(await opens("2024")).toBe(true);
    expect(await opens("2024")).toBe(false);
    expect(await opens("all")).toBe(true);
    expect(await opens("2024")).toBe(false);

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(await opens("2024")).toBe(true);
    expect(await opens("2024")).toBe(true);
  });

  it("is not seen while it never played, its code too late", async () => {
    // A slow phone: the feature bundle misses the intro's wait
    loader.loadFeatures.mockImplementation(() => new Promise(() => {}));
    mockApp.selectedYear = "2023";

    await openWithIntro();
    await vi.runAllTimersAsync();
    wrappedManager.closeWrapped();
    await vi.runAllTimersAsync();

    expect(sessionStorage.getItem(INTRO_SEEN_KEY) ?? "").not.toContain("2023");
  });

  describe("settling beside the cards", () => {
    /** The cards column side by side, 500 px wide and 24 px from the map */
    beforeEach(() => {
      Object.defineProperty(column(), "offsetWidth", {
        configurable: true,
        get: () => 500,
      });
      el("wrapped-content").style.columnGap = "24px";
    });

    /** The padding of the map's view as each overview was fitted */
    let fitted: unknown[] = [];
    beforeEach(() => {
      fitted = [];
      const fit = map().cameraForBounds.getMockImplementation()!;
      map().cameraForBounds.mockImplementation((bounds, options) => {
        fitted.push({ ...map().padding });
        return fit(bounds, options);
      });
    });
    const paddingsFitted = (): unknown[] => fitted;

    it("fits the overview as the map's panel shows it, its view padded by the room of the cards, and sets it back once there", async () => {
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS + INTRO_TURN_MS);

      // Both fits, the one the cloud is cut for and the settle's
      const room = { ...NO_PADDING, left: 524 };
      expect(paddingsFitted()).toEqual([room, room]);
      expect(map().cameraForBounds.mock.calls[0]![1]).toMatchObject({
        padding: FIT_PADDING,
        bearing: 0,
      });
      // The settle eases the padding in with the camera, and the map is
      // not measured until it is in its panel
      expect(lastMove("easeTo")![0]).toMatchObject({ padding: room });
      map().resize.mockClear();

      await vi.advanceTimersByTimeAsync(INTRO_SETTLE_MS);
      // Unpadded before it is measured and fitted in its panel
      expect(map().padding).toEqual(NO_PADDING);
      expect(map().setPadding.mock.invocationCallOrder.at(-1)!).toBeLessThan(
        map().resize.mock.invocationCallOrder[0]!,
      );
      expect(map().resize.mock.invocationCallOrder[0]!).toBeLessThan(
        map().fitBounds.mock.invocationCallOrder[0]!,
      );
    });

    it("ends where it was going at a press on the map, on the flat heatmap and the projection of before", async () => {
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS + INTRO_TURN_MS);
      const measured = map().resize.mock.calls.length;

      map().getContainer().dispatchEvent(new Event("pointerdown"));
      expect(modal().classList.contains("is-settling")).toBe(false);
      expect(map().stop).toHaveBeenCalled();
      expect(map().padding).toEqual(NO_PADDING);
      expect(map().resize.mock.calls.length).toBe(measured + 1);
      expect(lastMove("fitBounds")![1]).toMatchObject({ animate: false });
      expect(mockApp.store.get("globeVisible")).toBe(false);
      expect(mockApp.store.get("forcedHeatCloud")).toBe(false);

      // And only once
      await vi.runAllTimersAsync();
      expect(map().fitBounds).toHaveBeenCalledOnce();
    });

    it("fits the overview to the whole map where the cards are stacked", async () => {
      Object.defineProperty(column(), "offsetWidth", {
        configurable: true,
        get: () => 0,
      });
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS + INTRO_TURN_MS);
      expect(paddingsFitted()).toEqual([NO_PADDING, NO_PADDING]);
    });
  });

  describe("with every flight of the overview playing underneath", () => {
    /** The one player of the app, and what it was asked to play */
    function player(): InstanceType<typeof features.ReplayAllPlayer> {
      expect(features.ReplayAllPlayer.made).toHaveLength(1);
      return features.ReplayAllPlayer.made[0]!;
    }

    it("starts them with the flight home, at a few hundred times their speed, and stops them at the settle", async () => {
      mockApp.selectedAircraft = "D-ABCD";
      await openWithIntro();
      const replay = player();
      expect(replay.app).toBe(mockApp);
      expect(replay.start).toHaveBeenCalledOnce();
      const [run] = replay.start.mock.lastCall as [
        { pathIds: Set<number>; speed: number; zoom: number; scale: number },
      ];
      // The flights Wrapped describes: the year's, of the aircraft chosen
      expect([...run.pathIds].sort()).toEqual([1, 2]);
      expect(run.speed).toBeGreaterThanOrEqual(100);
      expect(run.speed).toBeLessThanOrEqual(500);
      // Larger than their own size, over the view of a whole year
      expect(run.scale).toBeGreaterThan(1);
      // Cut for the view over home the camera flies to, and cut before it
      // sets off, as the dark lifts
      const [fly] = lastMove("flyTo")! as [{ zoom: number }];
      expect(run.zoom).toBe(fly.zoom);
      expect(replay.start.mock.invocationCallOrder[0]!).toBeLessThan(
        map().flyTo.mock.invocationCallOrder[0]!,
      );
      expect(mapPanel().classList.contains("is-dark")).toBe(false);

      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS);
      expect(replay.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(INTRO_TURN_MS);
      expect(replay.stop).toHaveBeenCalledOnce();
      // Stopped before the settle's move, as the cards come in
      expect(replay.stop.mock.invocationCallOrder[0]!).toBeLessThan(
        map().easeTo.mock.invocationCallOrder.at(-1)!,
      );
      // Not a replay of the map: nothing of the app changed for it
      expect(mockApp.store.get("replayActive")).toBe(false);
      expect(mockApp.store.get("selectedYear")).toBe("2024");
      expect(mockApp.store.get("selectedAircraft")).toBe("D-ABCD");
      await vi.runAllTimersAsync();
      expect(replay.stop).toHaveBeenCalledOnce();
    });

    it("stops them on Skip", async () => {
      await openWithIntro();
      skipButton().click();
      expect(player().stop).toHaveBeenCalledOnce();
    });

    it("stops them on a press on the map", async () => {
      await openWithIntro();
      map().getContainer().dispatchEvent(new Event("pointerdown"));
      expect(player().stop).toHaveBeenCalledOnce();
    });

    it("stops them as the dialog closes, or is torn down, while the intro plays", async () => {
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS / 2);
      wrappedManager.closeWrapped();
      expect(player().stop).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();

      await openWithIntro();
      wrappedManager.destroy();
      expect(player().stop).toHaveBeenCalledTimes(2);
    });

    it("keeps one player for the app, from one opening to the next", async () => {
      await openWithIntro();
      await vi.advanceTimersByTimeAsync(INTRO_FLY_MS + INTRO_TURN_MS);
      wrappedManager.closeWrapped();
      await vi.runAllTimersAsync();
      await openWithIntro();

      expect(player().start).toHaveBeenCalledTimes(2);
      expect(player().stop).toHaveBeenCalledOnce();
      skipButton().click();
      expect(player().stop).toHaveBeenCalledTimes(2);
    });

    it("does not start them while a replay of the map runs", async () => {
      wrappedManager.showWrapped(true);
      mockApp.store.set("replayActive", true);
      await vi.advanceTimersByTimeAsync(MAP_IN_DIALOG_MS);

      expect(map().flyTo).toHaveBeenCalled();
      expect(features.ReplayAllPlayer.made).toHaveLength(0);
    });

    it("does not start them once motion has become unwelcome", async () => {
      const reduced = vi.spyOn(motion, "prefersReducedMotion");
      wrappedManager.showWrapped(true);
      reduced.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(MAP_IN_DIALOG_MS);

      expect(features.ReplayAllPlayer.made).toHaveLength(0);
    });

    it("has nothing to stop when no flight has a clock to play by", async () => {
      features.ReplayAllPlayer.flightsToPlay = 0;
      await openWithIntro();
      expect(player().start).toHaveBeenCalledOnce();
      skipButton().click();
      expect(player().stop).not.toHaveBeenCalled();
    });
  });

  describe("prepared from the button", () => {
    it("fetches the cloud's code and cuts its points for the overview, and the level below, each in a task of its own and not in the pointer's", async () => {
      map().cameraForBounds.mockReturnValue({
        center: { lng: 9, lat: 49 },
        zoom: 6.6,
        bearing: 0,
      } as never);
      prepareWrappedIntro(asMapApp(mockApp));
      // The code has arrived, and the task that asked for it is over
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(features.followHeatCloud).toHaveBeenCalledWith(mockApp);
      expect(features.prepareHeatCloud).not.toHaveBeenCalled();

      await vi.advanceTimersToNextTimerAsync();
      expect(features.prepareHeatCloud.mock.calls).toEqual([[mockApp, [6]]]);
      await vi.advanceTimersToNextTimerAsync();
      expect(features.prepareHeatCloud.mock.calls).toEqual([
        [mockApp, [6]],
        [mockApp, [5, 6]],
      ]);
    });

    it("cuts them once the page has a moment, where the browser tells", async () => {
      const idle: [() => void, { timeout?: number } | undefined][] = [];
      vi.stubGlobal(
        "requestIdleCallback",
        (work: () => void, options?: { timeout?: number }) =>
          idle.push([work, options]),
      );
      try {
        map().cameraForBounds.mockReturnValue({
          center: { lng: 9, lat: 49 },
          zoom: 6.6,
          bearing: 0,
        } as never);
        prepareWrappedIntro(asMapApp(mockApp));
        await vi.runAllTimersAsync();
        expect(features.prepareHeatCloud).not.toHaveBeenCalled();
        expect(idle).toHaveLength(1);
        // Not held back for long by a busy page
        expect(idle[0]![1]!.timeout).toBeGreaterThan(0);

        idle[0]![0]();
        expect(features.prepareHeatCloud.mock.calls).toEqual([[mockApp, [6]]]);
        expect(idle).toHaveLength(2);
        idle[1]![0]();
        expect(features.prepareHeatCloud.mock.calls).toEqual([
          [mockApp, [6]],
          [mockApp, [5, 6]],
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("cuts nothing ahead once the dialog is open by then, which cuts its points itself", async () => {
      map().cameraForBounds.mockReturnValue({
        center: { lng: 9, lat: 49 },
        zoom: 6.6,
        bearing: 0,
      } as never);
      prepareWrappedIntro(asMapApp(mockApp));
      for (let i = 0; i < 5; i++) await Promise.resolve();
      mockApp.store.set("wrappedVisible", true);
      await vi.runAllTimersAsync();

      expect(features.prepareHeatCloud).not.toHaveBeenCalled();
    });

    it("prepares nothing under reduced motion, while open, or without data", async () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      prepareWrappedIntro(asMapApp(mockApp));
      vi.mocked(motion.prefersReducedMotion).mockReturnValue(false);
      mockApp.store.set("wrappedVisible", true);
      prepareWrappedIntro(asMapApp(mockApp));
      mockApp.store.set("wrappedVisible", false);
      mockApp.currentData = null;
      prepareWrappedIntro(asMapApp(mockApp));
      await vi.runAllTimersAsync();

      expect(loader.loadFeatures).not.toHaveBeenCalled();
    });
  });

  describe("destinations", () => {
    /** Point at the row of `code`, and rest there */
    async function hover(
      code: string,
      pointerType = "mouse",
      rest = 300,
    ): Promise<void> {
      const row = [
        ...el("wrapped-airports-grid").querySelectorAll(".destination"),
      ].find((r) => r.querySelector(".destination-code")?.textContent === code);
      const event = new Event("pointerover", { bubbles: true });
      Object.assign(event, { pointerType });
      row!.querySelector(".destination-name")!.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(rest);
    }

    async function leave(rest = 300): Promise<void> {
      const event = new Event("pointerleave");
      Object.assign(event, { pointerType: "mouse" });
      el("wrapped-airports-grid").dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(rest);
    }

    beforeEach(async () => {
      await openWithIntro();
      skipButton().click();
      map().flyTo.mockClear();
      map().fitBounds.mockClear();
    });

    it("flies the map to the one the pointer rests on, and back to the overview after", async () => {
      await hover("LOWW");
      expect(lastMove("flyTo")![0]).toMatchObject({ center: [16.57, 48.11] });

      await hover("EDDM");
      expect(map().flyTo).toHaveBeenCalledTimes(2);
      expect(lastMove("flyTo")![0]).toMatchObject({ center: [11.79, 48.35] });

      await leave();
      expect(lastMove("fitBounds")![1]).toMatchObject({ bearing: 0, pitch: 0 });
    });

    it("leaves a pointer on its way through the list, and a view the user moved to, alone", async () => {
      // Through two rows without resting on either
      await hover("LOWW", "mouse", 100);
      await hover("EDDM");
      expect(map().flyTo).toHaveBeenCalledOnce();
      expect(lastMove("flyTo")![0]).toMatchObject({ center: [11.79, 48.35] });
      await leave();
      expect(map().fitBounds).toHaveBeenCalledOnce();

      // Nothing flown, nothing to fly back from
      map().fitBounds.mockClear();
      await leave();
      expect(map().fitBounds).not.toHaveBeenCalled();

      // A press on the map drops the flight back as it waits, and the one
      // to a destination
      await hover("LOWW");
      await leave(0);
      map().getContainer().dispatchEvent(new Event("pointerdown"));
      await hover("EDDM", "mouse", 0);
      map().getContainer().dispatchEvent(new Event("wheel"));
      await vi.runAllTimersAsync();
      expect(map().fitBounds).not.toHaveBeenCalled();
      expect(map().flyTo).toHaveBeenCalledTimes(2);
    });

    it("does not follow a finger, reduced motion, or a closed dialog", async () => {
      await hover("LOWW", "touch");
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      await hover("EDDM");
      vi.mocked(motion.prefersReducedMotion).mockReturnValue(false);
      wrappedManager.closeWrapped();
      await hover("LOWW");
      await vi.runAllTimersAsync();
      expect(map().flyTo).not.toHaveBeenCalled();

      // Nor a pointer resting as the dialog closes
      wrappedManager.showWrapped();
      const row = el("wrapped-airports-grid").querySelector(".destination")!;
      row.dispatchEvent(new Event("pointerover", { bubbles: true }));
      wrappedManager.closeWrapped();
      await vi.runAllTimersAsync();
      expect(map().flyTo).not.toHaveBeenCalled();
    });
  });
});
