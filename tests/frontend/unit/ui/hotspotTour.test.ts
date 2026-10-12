/**
 * The hotspot tour: its places from what the heatmap shows, the flight
 * from one to the next and the turn over each, pause and resume, the
 * steps, the three ways it ends (back to the start, left to the user's
 * hand, left to what took the map), reduced motion, the controls it holds
 * and what it says.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createHotspotTour,
  type HotspotTour,
  TOUR_DWELL_MS,
  TOUR_FLY_MS,
  TOUR_NOTHING_MESSAGE,
  TOUR_RETURN_MS,
  TOUR_TURN_DEG,
  toggleHotspotTour,
  tourZoom,
} from "../../../../flown/frontend/ui/hotspotTour";
import {
  resetSiteData,
  siteData,
} from "../../../../flown/frontend/state/siteData";
import type { PathInfo, PathSegment } from "../../../../flown/frontend/types";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import { SELECTION_CONTROL_IDS } from "../../../../flown/frontend/ui/heldControls";
import { LIVE_REGION_DELAY_MS } from "../../../../flown/frontend/utils/toast";
import * as crossSection from "../../../../flown/frontend/ui/crossSection";
import * as motion from "../../../../flown/frontend/utils/motion";
import * as toast from "../../../../flown/frontend/utils/toast";
import {
  asMapApp,
  createDataset,
  createMockApp,
  isHeld,
  el,
  segmentOf,
  type MockApp,
} from "../../testHelpers";

/** Degrees of latitude in a kilometre */
const KM = 1 / 111.32;

/** The home field, and a field 30 km east of it */
const HOME: [number, number] = [51.55, 12.05];
const AWAY: [number, number] = [51.55, 12.05 + (30 * KM) / Math.cos(0.9)];

/** A flight of `path_id` spending `minutes` at `[lat, lng]`, a fix a minute */
function stay(
  path_id: number,
  [lat, lng]: [number, number],
  minutes: number,
): PathSegment[] {
  return Array.from({ length: minutes }, (_, i) =>
    segmentOf({
      path_id,
      coords: [
        [lat + (i % 2) * 0.001, lng],
        [lat + ((i + 1) % 2) * 0.001, lng],
      ],
      time: i * 60,
    }),
  );
}

/** Two flights from home, one of an hour there and one of 20 minutes away */
function flights() {
  const info: PathInfo[] = [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-EABC",
      start_airport: "EDAQ Halle-Oppin",
      end_airport: "EDAQ Halle-Oppin",
    },
    {
      id: 2,
      year: 2025,
      aircraft_registration: "D-EXYZ",
      start_airport: "EDAQ Halle-Oppin",
      end_airport: "EDXX Away",
    },
  ];
  return createDataset(info, [...stay(1, HOME, 61), ...stay(2, AWAY, 21)]);
}

/**
 * The controls the tour holds, and its own: every one of the selection,
 * from the list a replay holds them by as well
 */
const HELD = [
  "heatmap-btn",
  "three-d-btn",
  "year-select",
  ...SELECTION_CONTROL_IDS,
  "replay-all-btn",
  "wrapped-btn",
  "cross-section-btn",
];

describe("hotspot tour", () => {
  let app: MockApp;
  let tour: HotspotTour;
  /** The app's lifetime: a tour left open listens to the page until it ends */
  let lifetime: AbortController;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const panel = (): HTMLElement => el("hotspot-tour");
  const text = (id: string): string => el(id).textContent ?? "";
  const press = (id: string): void => el(id).click();
  const live = async (): Promise<string> => {
    await vi.advanceTimersByTimeAsync(LIVE_REGION_DELAY_MS);
    return text("hotspot-tour-live");
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
    document.body.innerHTML = '<div id="map"></div>';
    for (const id of HELD) {
      const control = document.createElement(
        id.endsWith("select") ? "select" : "button",
      );
      control.id = id;
      document.body.append(control);
    }
    const button = document.createElement("button");
    button.id = "hotspot-tour-btn";
    button.setAttribute("aria-pressed", "false");
    document.body.append(button);
    siteData.airports = [
      { name: "EDAQ Halle-Oppin", lat: HOME[0], lon: HOME[1] },
      { name: "EDXX Away", lat: AWAY[0], lon: AWAY[1] },
    ];
    lifetime = new AbortController();
    app = createMockApp({
      currentData: flights(),
      heatmapVisible: false,
      signal: lifetime.signal,
    });
    map().jumpTo({ center: [12.4, 51.3], zoom: 8, bearing: 10, pitch: 0 });
    map().jumpTo.mockClear();
    tour = createHotspotTour(asMapApp(app));
  });

  afterEach(() => {
    lifetime.abort();
    vi.useRealTimers();
    document.body.innerHTML = "";
    resetSiteData();
  });

  /** The options and the event data of the last call of a camera move */
  function last(
    move: "jumpTo" | "flyTo" | "easeTo",
  ): [Record<string, unknown>, unknown] {
    const call = map()[move].mock.lastCall as unknown[];
    return [call[0] as Record<string, unknown>, call[1]];
  }

  it("starts at the busiest place, in the 3D view with the heatmap, and says where", async () => {
    tour.start();

    expect(tour.isOpen).toBe(true);
    expect(app.store.get("threeDVisible")).toBe(true);
    expect(app.store.get("heatmapVisible")).toBe(true);
    // The user's view, for the state manager to save meanwhile
    expect(app.tourView).toMatchObject({
      center: { lat: 51.3, lng: 12.4 },
      zoom: 8,
      bearing: 10,
      threeDVisible: false,
    });

    const [fly, tag] = last("flyTo");
    expect(fly).toMatchObject({
      pitch: 60,
      bearing: 10,
      duration: TOUR_FLY_MS,
    });
    expect((fly["center"] as number[])[0]).toBeCloseTo(HOME[1], 2);
    expect(tag).toBe(REPLAY_CAMERA_MOVE);

    expect(panel().hidden).toBe(false);
    expect(text("hotspot-tour-count")).toBe("1 of 2");
    expect(text("hotspot-tour-name")).toBe("Home field EDAQ Halle-Oppin");
    expect(text("hotspot-tour-detail")).toBe("1 h, 75% of the time");
    expect(await live()).toBe(
      "1 of 2: Home field EDAQ Halle-Oppin, 1 h, 75% of the time",
    );
    expect(el("hotspot-tour-live").getAttribute("aria-live")).toBe("polite");

    // Held, as for a replay, and the control says it runs
    for (const id of HELD) {
      expect(isHeld(el(id)), id).toBe(true);
    }
    expect(el("hotspot-tour-btn").getAttribute("aria-pressed")).toBe("true");
    expect(document.body.classList.contains("hotspot-tour-active")).toBe(true);
    expect(document.activeElement?.id).toBe("hotspot-tour-play-btn");
    expect(el("hotspot-tour-play-btn").getAttribute("aria-label")).toBe(
      "Pause the tour",
    );
    expect(el("hotspot-tour-previous-btn").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("turns slowly over each place, moves on, and flies back where it started as it ends", async () => {
    tour.start();
    expect(map().fire).not.toHaveBeenCalledWith("zoomend");

    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS);
    // Arrived, the app follows the view: the relief level of the 3D view
    // and its exaggeration, the ribbons, the saved view
    expect(map().fire).toHaveBeenCalledWith("zoomend");
    expect(map().fire).toHaveBeenCalledWith("moveend");
    const [turn, turnTag] = last("easeTo");
    expect(turn).toMatchObject({
      bearing: 10 + TOUR_TURN_DEG,
      duration: TOUR_DWELL_MS,
    });
    expect((turn["easing"] as (t: number) => number)(0.3)).toBe(0.3);
    expect(turnTag).toBe(REPLAY_CAMERA_MOVE);

    await vi.advanceTimersByTimeAsync(TOUR_DWELL_MS);
    // On from where the turn ended
    const [second] = last("flyTo");
    expect(second).toMatchObject({ bearing: 10 + TOUR_TURN_DEG });
    expect((second["center"] as number[])[0]).toBeCloseTo(AWAY[1], 2);
    expect(text("hotspot-tour-count")).toBe("2 of 2");
    expect(text("hotspot-tour-name")).toBe("EDXX Away");
    expect(el("hotspot-tour-next-btn").getAttribute("aria-label")).toBe(
      "End the tour",
    );

    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS + TOUR_DWELL_MS);
    expect(tour.isOpen).toBe(false);
    const [back, backTag] = last("flyTo");
    expect(back).toMatchObject({
      center: [12.4, 51.3],
      zoom: 8,
      bearing: 10,
      pitch: 0,
      duration: TOUR_RETURN_MS,
    });
    // Not scripted: the app follows it as it comes to rest
    expect(backTag).toBeUndefined();
    expect(app.store.get("threeDVisible")).toBe(false);
    expect(app.store.get("heatmapVisible")).toBe(false);
    expect(app.tourView).toBeNull();
    expect(panel().hidden).toBe(true);
    for (const id of HELD) {
      expect(isHeld(el(id)), id).toBe(false);
    }
    expect(el("hotspot-tour-btn").getAttribute("aria-pressed")).toBe("false");
    expect(document.body.classList.contains("hotspot-tour-active")).toBe(false);
    // Its focus goes back to the control that started it
    expect(document.activeElement?.id).toBe("hotspot-tour-btn");

    // Nothing more moves the camera
    const moves =
      map().flyTo.mock.calls.length + map().easeTo.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(map().flyTo.mock.calls.length + map().easeTo.mock.calls.length).toBe(
      moves,
    );
  });

  it("pauses where it is and goes on from there, over a place and on the way to one", async () => {
    tour.start();
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS + 3000);

    press("hotspot-tour-play-btn");
    expect(tour.isPlaying).toBe(false);
    expect(map().stop).toHaveBeenCalled();
    expect(el("hotspot-tour-play-btn").getAttribute("aria-label")).toBe(
      "Play the tour",
    );
    expect(await live()).toBe("Tour paused");
    const moves = map().easeTo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TOUR_DWELL_MS * 3);
    expect(map().easeTo.mock.calls.length).toBe(moves);
    expect(tour.current).toBe(0);

    press("hotspot-tour-play-btn");
    expect(await live()).toBe("Tour playing");
    // The rest of the turn, at the same pace
    const [turn] = last("easeTo");
    expect(turn).toMatchObject({
      bearing: 10 + TOUR_TURN_DEG,
      duration: TOUR_DWELL_MS - 3000,
    });
    await vi.advanceTimersByTimeAsync(
      TOUR_DWELL_MS - 3000 - LIVE_REGION_DELAY_MS,
    );
    expect(tour.current).toBe(1);

    // Paused on the way, the flight goes on with what was left of it
    await vi.advanceTimersByTimeAsync(1000);
    tour.pause();
    tour.resume();
    const [fly] = last("flyTo");
    expect(fly).toMatchObject({ duration: TOUR_FLY_MS - 1000 });
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS - 1000);
    expect(last("easeTo")[0]).toMatchObject({ duration: TOUR_DWELL_MS });
  });

  it("pauses while the tab is hidden, and plays on once it is back", async () => {
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const show = (now: boolean): void => {
      hidden = !now;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    tour.start();
    await vi.advanceTimersByTimeAsync(1000);

    // The camera's frames stop in a hidden tab, and the tour's steps with
    // them, as a click on Pause would stop them
    show(false);
    expect(tour.isPlaying).toBe(false);
    expect(el("hotspot-tour-play-btn").getAttribute("aria-label")).toBe(
      "Play the tour",
    );
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS * 3);
    expect(tour.current).toBe(0);

    // Back, the flight goes on with what was left of it
    show(true);
    expect(tour.isPlaying).toBe(true);
    expect(last("flyTo")[0]).toMatchObject({ duration: TOUR_FLY_MS - 1000 });

    // A tour paused by hand stays paused through a hidden tab
    press("hotspot-tour-play-btn");
    show(false);
    show(true);
    expect(tour.isPlaying).toBe(false);
  });

  it("steps to the next place and back, and ends after the last", async () => {
    tour.start();

    // Nothing before the first
    press("hotspot-tour-previous-btn");
    expect(tour.current).toBe(0);
    expect(map().flyTo).toHaveBeenCalledOnce();

    press("hotspot-tour-next-btn");
    expect(tour.current).toBe(1);
    expect(el("hotspot-tour-previous-btn").getAttribute("aria-disabled")).toBe(
      "false",
    );
    expect(await live()).toBe("2 of 2: EDXX Away, 20 min, 25% of the time");
    // It plays on from the new place
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS);
    expect(last("easeTo")[0]).toMatchObject({
      bearing: 10 + 2 * TOUR_TURN_DEG,
    });

    press("hotspot-tour-previous-btn");
    expect(tour.current).toBe(0);
    press("hotspot-tour-next-btn");
    press("hotspot-tour-next-btn");
    expect(tour.isOpen).toBe(false);
    expect(app.store.get("threeDVisible")).toBe(false);
  });

  it("flies to a place stepped to while paused, and waits there", async () => {
    tour.start();
    tour.pause();

    map().fire.mockClear();
    tour.next();
    expect(tour.current).toBe(1);
    const flights = map().flyTo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS - 1);
    expect(map().fire).not.toHaveBeenCalled();
    // There: the app follows the view it came to, the relief level and the
    // cut of the cloud with it, as when it plays
    await vi.advanceTimersByTimeAsync(1);
    expect(map().fire).toHaveBeenCalledWith("zoomend");
    expect(map().fire).toHaveBeenCalledWith("moveend");
    await vi.advanceTimersByTimeAsync(TOUR_DWELL_MS);
    expect(map().easeTo).not.toHaveBeenCalled();

    // Landed by now: resumed, it turns over the place at once
    tour.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(map().flyTo.mock.calls.length).toBe(flights);
    expect(last("easeTo")[0]).toMatchObject({ duration: TOUR_DWELL_MS });
  });

  it("goes back to the tilt the replay of all flights was laying the map back to", () => {
    // Started half way back from the tilt of that replay
    map().jumpTo({ pitch: 25 });
    app.replayState.layingBack = 0;

    tour.start();
    tour.stop();

    expect(last("flyTo")[0]).toMatchObject({ pitch: 0 });
  });

  it("stops with its button or Escape, back where it started", async () => {
    tour.start();
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS);

    // The toasts stack above the panel meanwhile (features.css)
    expect(document.body.style.getPropertyValue("--tour-panel-h")).toBe("0px");
    press("hotspot-tour-stop-btn");
    expect(tour.isOpen).toBe(false);
    expect(last("flyTo")[0]).toMatchObject({ center: [12.4, 51.3], zoom: 8 });
    expect(app.store.get("threeDVisible")).toBe(false);
    expect(document.body.style.getPropertyValue("--tour-panel-h")).toBe("");

    tour.start();
    expect(tour.isOpen).toBe(true);
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    el("hotspot-tour-next-btn").dispatchEvent(escape);
    expect(tour.isOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(true);

    // Not an Escape that closes a popup first, nor one another handler took
    tour.start();
    const popup = document.createElement("div");
    popup.className = "maplibregl-popup";
    document.body.append(popup);
    popup.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    const taken = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    taken.preventDefault();
    document.dispatchEvent(taken);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(tour.isOpen).toBe(true);
    // Nor one in a text field, which empties it
    const search = document.createElement("input");
    search.type = "search";
    document.body.append(search);
    const typed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(typed);
    expect(tour.isOpen).toBe(true);
    expect(typed.defaultPrevented).toBe(false);
    search.remove();
  });

  it("follows the height of its panel as it wraps anew", () => {
    // Measured as a step was shown only: a turn of the phone left the
    // toasts standing on the panel, or far above it
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    try {
      tour.start();
      const panel = document.getElementById("hotspot-tour")!;
      vi.spyOn(panel, "offsetHeight", "get").mockReturnValue(96);

      for (const observer of observers) {
        observer([], {} as ResizeObserver);
      }

      expect(document.body.style.getPropertyValue("--tour-panel-h")).toBe(
        "96px",
      );
      tour.stop();
      expect(document.body.style.getPropertyValue("--tour-panel-h")).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ends where it is, in the 3D view, when the user takes the map over", async () => {
    tour.start();
    await vi.advanceTimersByTimeAsync(TOUR_FLY_MS + 1000);
    const container = map().getContainer();

    // Keys that move nothing, and Escape, which stops it, are not a hand
    for (const key of ["Tab", "Shift"]) {
      container.dispatchEvent(new KeyboardEvent("keydown", { key }));
    }
    expect(tour.isOpen).toBe(true);

    const flights = map().flyTo.mock.calls.length;
    map().fire.mockClear();
    map().stop.mockClear();
    // The hand is on the map, which keeps the focus it took
    const canvas = map().getCanvas();
    canvas.focus();
    container.dispatchEvent(new Event("pointerdown"));

    expect(tour.isOpen).toBe(false);
    expect(document.activeElement).toBe(canvas);
    expect(map().flyTo.mock.calls.length).toBe(flights);
    // A press that moves nothing stops the turn where it is, and the app
    // follows that view
    expect(map().stop).toHaveBeenCalled();
    expect(map().fire).toHaveBeenCalledWith("moveend");
    expect(app.store.get("threeDVisible")).toBe(true);
    expect(app.store.get("heatmapVisible")).toBe(true);
    // The view and the switches are the user's now
    expect(app.tourView).toBeNull();
    expect(app.stateManager.scheduleSave).toHaveBeenCalled();
    expect(panel().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(LIVE_REGION_DELAY_MS);
    expect(text("toast-status")).toBe("Hotspot tour ended here");

    // A key on the map does as well
    tour.start();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(tour.isOpen).toBe(false);
  });

  it("cuts to each place under reduced motion, and waits for the user", async () => {
    vi.mocked(motion.prefersReducedMotion).mockReturnValue(true);
    tour.start();

    const [cut, tag] = last("jumpTo");
    expect(cut).toMatchObject({ pitch: 60, bearing: 10 });
    expect(tag).toBe(REPLAY_CAMERA_MOVE);
    expect(map().flyTo).not.toHaveBeenCalled();
    expect(el("hotspot-tour-play-btn").hidden).toBe(true);
    expect(document.activeElement?.id).toBe("hotspot-tour-next-btn");

    await vi.advanceTimersByTimeAsync((TOUR_FLY_MS + TOUR_DWELL_MS) * 3);
    expect(tour.current).toBe(0);
    expect(map().easeTo).not.toHaveBeenCalled();
    // Nothing to pause or resume
    tour.pause();
    tour.resume();
    expect(map().easeTo).not.toHaveBeenCalled();

    press("hotspot-tour-next-btn");
    expect(tour.current).toBe(1);
    expect(map().jumpTo).toHaveBeenCalledTimes(2);

    press("hotspot-tour-next-btn");
    expect(tour.isOpen).toBe(false);
    const [back, backTag] = last("jumpTo");
    expect(back).toMatchObject({ center: [12.4, 51.3], zoom: 8 });
    expect(backTag).toBeUndefined();
    expect(map().flyTo).not.toHaveBeenCalled();
  });

  it("tours what the filters and Isolate keep", () => {
    app.store.set("selectedPathIds", new Set([2]));
    app.store.set("isolateSelection", true);

    tour.start();

    expect(tour.length).toBe(1);
    expect(text("hotspot-tour-name")).toBe("EDXX Away");
    expect(text("hotspot-tour-detail")).toBe("20 min, 100% of the time");
    tour.stop();

    app.store.set("isolateSelection", false);
    app.store.set("selectedAircraft", "D-EABC");
    tour.start();
    expect(tour.length).toBe(1);
    expect(text("hotspot-tour-name")).toBe("Home field EDAQ Halle-Oppin");
  });

  it("closes the cross-section, whose line is on the map it flies over", () => {
    vi.spyOn(crossSection, "crossSectionOpen").mockReturnValue(true);
    const toggle = vi
      .spyOn(crossSection, "toggleCrossSection")
      .mockImplementation(() => {});

    tour.start();

    expect(toggle).toHaveBeenCalledWith(asMapApp(app));
    expect(tour.isOpen).toBe(true);
    expect(isHeld(el("cross-section-btn"))).toBe(true);
  });

  it("does not start while another has the map, nor with nothing to tour", () => {
    const toastSpy = vi.spyOn(toast, "showToast");
    app.store.set("replayActive", true);
    tour.start();
    expect(tour.isOpen).toBe(false);

    app.store.set("replayActive", false);
    app.store.set("wrappedVisible", true);
    tour.start();
    expect(tour.isOpen).toBe(false);
    expect(toastSpy).not.toHaveBeenCalled();

    app.store.set("wrappedVisible", false);
    app.store.set("selectedYear", "2019");
    tour.start();
    expect(tour.isOpen).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith(TOUR_NOTHING_MESSAGE, "info");
    expect(app.store.get("threeDVisible")).toBe(false);

    // Nor before any flight has loaded
    toastSpy.mockClear();
    app.store.set("selectedYear", "all");
    app.store.set("currentData", null);
    tour.start();
    expect(tour.isOpen).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith(TOUR_NOTHING_MESSAGE, "info");
  });

  it("does nothing it is asked while it does not run", () => {
    tour.next();
    tour.previous();
    tour.pause();
    tour.resume();
    tour.stop();

    expect(map().flyTo).not.toHaveBeenCalled();
    expect(map().jumpTo).not.toHaveBeenCalled();
    expect(document.getElementById("hotspot-tour")).toBeNull();
  });

  it("names the places by their position without the airports, and runs without its control", () => {
    siteData.airports = null;
    el("hotspot-tour-btn").remove();

    tour.start();

    expect(text("hotspot-tour-name")).toBe("51.55° N, 12.05° E");
    tour.stop();
    expect(tour.isOpen).toBe(false);
  });

  it("goes back on new flights, and leaves the camera to a replay that takes the map", () => {
    tour.start();
    app.store.set("currentData", flights());
    expect(tour.isOpen).toBe(false);
    expect(last("flyTo")[0]).toMatchObject({ center: [12.4, 51.3] });

    tour.start();
    const flights2 = map().flyTo.mock.calls.length;
    map().stop.mockClear();
    app.store.set("replayActive", true);
    expect(tour.isOpen).toBe(false);
    expect(app.store.get("threeDVisible")).toBe(false);
    expect(map().flyTo.mock.calls.length).toBe(flights2);
    // Its own flight does not go on under the replay
    expect(map().stop).toHaveBeenCalled();
  });

  it("leaves a move of what took the map alone", () => {
    tour.start();
    // The replay's own move starts, which ends the tour's flight
    map().emit("moveend");
    map().stop.mockClear();

    app.store.set("replayActive", true);

    expect(tour.isOpen).toBe(false);
    expect(map().stop).not.toHaveBeenCalled();
  });

  it("goes back where it first started when started again on the way back", () => {
    tour.start();
    tour.stop();
    // Part of the way back as it starts again
    map().jumpTo({ center: [12.3, 51.4], zoom: 7, bearing: 30, pitch: 40 });

    tour.start();
    expect(app.tourView).toMatchObject({
      center: { lng: 12.4, lat: 51.3 },
      zoom: 8,
      bearing: 10,
      pitch: 0,
      threeDVisible: false,
      heatmapVisible: false,
    });
    tour.stop();
    expect(last("flyTo")[0]).toMatchObject({
      center: [12.4, 51.3],
      zoom: 8,
      bearing: 10,
      pitch: 0,
    });

    // Once the map got there, or was stopped on the way, it starts from
    // where the map is
    map().emit("moveend");
    map().jumpTo({ center: [12.3, 51.4], zoom: 7, bearing: 30, pitch: 40 });
    tour.start();
    expect(app.tourView).toMatchObject({
      center: { lng: 12.3, lat: 51.4 },
      zoom: 7,
      bearing: 30,
      pitch: 40,
    });
  });

  it("gives the controls back as they were", () => {
    el("isolate-btn").setAttribute("aria-disabled", "true");

    tour.start();
    tour.stop();

    expect(isHeld(el("isolate-btn"))).toBe(true);
    expect((el("year-select") as HTMLSelectElement).disabled).toBe(false);
  });

  it("hands the focus to the phone's More tab where the bar stands in for the columns", () => {
    const more = document.createElement("button");
    more.id = "mobile-tab-more";
    document.body.append(more);
    app.mobileBar = {
      isVisible: () => true,
    } as unknown as MockApp["mobileBar"];

    tour.start();
    tour.stop();

    expect(document.activeElement).toBe(more);
  });

  it("stops with the app, and leaves the map as it is", () => {
    tour.start();
    const flights2 = map().flyTo.mock.calls.length;

    lifetime.abort();

    expect(tour.isOpen).toBe(false);
    expect(map().flyTo.mock.calls.length).toBe(flights2);
    expect(document.getElementById("hotspot-tour")).toBeNull();
  });

  it("is one tour per app, started and stopped by its control", () => {
    toggleHotspotTour(asMapApp(app));
    expect(document.querySelectorAll("#hotspot-tour")).toHaveLength(1);
    expect(panel().hidden).toBe(false);

    toggleHotspotTour(asMapApp(app));
    expect(panel().hidden).toBe(true);
    toggleHotspotTour(asMapApp(app));
    expect(document.querySelectorAll("#hotspot-tour")).toHaveLength(1);
    expect(panel().hidden).toBe(false);
  });

  it("zooms to show a place's ground across the smaller side of the map", () => {
    const place = { center: HOME, seconds: 1, share: 1, radiusM: 1000 };
    // 12 km across 800 px, 15 m a pixel, at 51.55° N
    expect(tourZoom(place, 1280, 800)).toBeCloseTo(11.66, 1);
    // A wide place further out, a small map not past the closest zoom
    expect(tourZoom({ ...place, radiusM: 3000 }, 1280, 800)).toBeCloseTo(
      10.66,
      1,
    );
    // Within the zooms the relief and the cloud are drawn well at
    expect(tourZoom(place, 4000, 4000)).toBe(13);
    expect(tourZoom(place, 0, 0)).toBe(9);
    expect(tourZoom({ ...place, radiusM: 1e6 }, 400, 400)).toBe(9);
  });
});
