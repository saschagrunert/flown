/**
 * ReplayManager: path redraw, frame display updates and the airplane popup.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../flown/frontend/ui/replayManager";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../flown/frontend/utils/colors";
import * as replayFeature from "../../../../flown/frontend/features/replay";
import { generateSegmentPopupHtml } from "../../../../flown/frontend/utils/htmlGenerators";
import * as mapHelpers from "../../../../flown/frontend/utils/mapHelpers";
import type { ReplayAirplane } from "../../../../flown/frontend/ui/replayState";
import {
  createReplayManager,
  createReplayMockApp,
  el,
  featuresOf,
  mockAnimationFrame,
  mountReplayDom,
  replaySources,
  unmountReplayDom,
  type MockApp,
} from "./replayTestSetup";
import { segmentOf } from "../../testHelpers";

vi.mock("../../../../flown/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

describe("ReplayManager display", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    replayManager = createReplayManager(mockApp);
    mockApp.selectedPathIds = new Set([1]);
    replayManager.initializeReplay();
    mockApp.replayActive = true;
    vi.mocked(generateSegmentPopupHtml).mockClear();
    replaySources(mockApp).route.setData.mockClear();
    replaySources(mockApp).trail.setData.mockClear();
  });

  /** Let the frame run in which the trail is handed to the map */
  function runFrame(): void {
    vi.advanceTimersByTime(16);
  }

  /** Colours of the trail on the map, one per run, in flight order */
  function drawnColors(): unknown[] {
    runFrame();
    return featuresOf(replaySources(mockApp).trail).map(
      (feature) => feature.properties["color"],
    );
  }

  function airplane(): ReplayAirplane {
    return replayManager.state.airplaneMarker!;
  }

  /** Where the map says the airplane is, in pixels of an 800 x 600 map */
  function airplaneAt(x: number, y: number): void {
    mockApp.map!.project.mockReturnValue({ x, y });
  }

  /** Positions the airplane was moved to, latitude first */
  function positions(): [number, number][] {
    return vi.mocked(airplane().marker.setLngLat).mock.calls.map(([lngLat]) => {
      const [lng, lat] = lngLat as [number, number];
      return [lat, lng];
    });
  }

  /** The colour of an altitude on the flight's own range, spread by rank */
  function altitudeColor(feet: number): string {
    const { min, max, ranks } = replayManager.state.colorAltRange;
    return getColorForAltitude(feet, min, max, ranks);
  }

  /** The colour of a groundspeed on the flight's own range */
  function speedColor(knots: number): string {
    const { min, max, ranks } = replayManager.state.colorSpeedRange;
    return getColorForAirspeed(knots, min, max, ranks);
  }

  afterEach(() => {
    vi.useRealTimers();
    unmountReplayDom();
  });

  describe("redrawReplayPath", () => {
    beforeEach(() => {
      replayManager.state.currentTime = 100;
      replayManager.state.lastDrawnIndex = 2;
    });

    it("rebuilds the trail up to savedIndex with altitude colors", () => {
      replayManager.redrawReplayPath("altitude");

      // Segments at t=0 and t=60 are at or before t=100
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      expect(drawnColors()).toEqual([altitudeColor(3000), altitudeColor(4000)]);
    });

    it("rebuilds the trail with airspeed colors", () => {
      replayManager.redrawReplayPath("airspeed");

      expect(drawnColors()).toEqual([speedColor(100), speedColor(120)]);
    });

    it("switches the colours of a trail that is already on the map", () => {
      replayManager.state.lastDrawnIndex = -1;
      replayManager.state.currentTime = 100;
      replayManager.updateReplayDisplay();
      expect(drawnColors()).toEqual([altitudeColor(3000), altitudeColor(4000)]);

      replayManager.redrawReplayPath("airspeed");

      expect(drawnColors()).toEqual([speedColor(100), speedColor(120)]);
      // One write for the trail as it was flown, one for the new colours
      expect(replaySources(mockApp).trail.setData).toHaveBeenCalledTimes(2);
    });

    it("leaves the route alone: it is laid down once, when replay opens", () => {
      replayManager.redrawReplayPath("altitude");
      runFrame();

      const { route } = replaySources(mockApp);
      expect(route.setData).not.toHaveBeenCalled();
      // One point per segment, plus the end of the last one
      expect(featuresOf(route)[0]!.geometry.coordinates).toHaveLength(
        replayManager.state.segments.length + 1,
      );
    });

    it("rebuilds the runs so a later backward seek still works", () => {
      replayManager.redrawReplayPath("airspeed");
      expect(replayManager.state.trailRuns).toHaveLength(2);

      replayManager.seekReplay("30");

      expect(replayManager.state.trailRuns).toHaveLength(1);
      expect(replayManager.state.lastDrawnIndex).toBe(0);
      expect(drawnColors()).toEqual([speedColor(100)]);
    });

    it("draws zero-groundspeed segments with the altitude colour", () => {
      // Skipping them would hide part of the trail
      replayManager.state.segments = [
        {
          path_id: 1,
          coords: [
            [51, 10],
            [51.1, 10.1],
          ],
          altitude_ft: 1000,
          groundspeed_knots: 0,
          time: 50,
        },
      ];
      replayManager.state.lastDrawnIndex = 0;

      replayManager.redrawReplayPath("airspeed");

      expect(replayManager.state.lastDrawnIndex).toBe(0);
      expect(replayManager.state.trailRuns).toHaveLength(1);
      expect(drawnColors()).toEqual([altitudeColor(1000)]);
    });

    it("keeps the runs aligned with lastDrawnIndex when speeds vary", () => {
      // A backward seek cuts the runs by segment index, so a redraw that
      // covered fewer segments than the index range would cut the wrong
      // part of the trail
      replayManager.state.segments = [
        {
          path_id: 1,
          coords: [
            [51, 10],
            [51.1, 10.1],
          ],
          altitude_ft: 1000,
          groundspeed_knots: 100,
          time: 0,
        },
        {
          path_id: 1,
          coords: [
            [51.1, 10.1],
            [51.2, 10.2],
          ],
          altitude_ft: 1200,
          groundspeed_knots: 0,
          time: 30,
        },
        {
          path_id: 1,
          coords: [
            [51.2, 10.2],
            [51.3, 10.3],
          ],
          altitude_ft: 1400,
          groundspeed_knots: 120,
          time: 60,
        },
      ];
      replayManager.state.currentTime = 100;
      replayManager.state.lastDrawnIndex = 2;

      replayManager.redrawReplayPath("airspeed");

      const runs = replayManager.state.trailRuns;
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      expect(runs[0]!.firstIndex).toBe(0);
      expect(runs[runs.length - 1]!.lastIndex).toBe(2);
      // Every segment is in exactly one run
      const covered = runs.reduce(
        (sum, run) => sum + run.lastIndex - run.firstIndex + 1,
        0,
      );
      expect(covered).toBe(3);
    });

    it("does nothing while the replay layer is not set up", () => {
      replayManager.state.layerActive = false;

      expect(() => replayManager.redrawReplayPath("altitude")).not.toThrow();
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      runFrame();
      expect(replaySources(mockApp).trail.setData).not.toHaveBeenCalled();
    });
  });

  describe("updateReplayDisplay", () => {
    it("tells a follower the time of every display", () => {
      const follow = vi.fn();
      replayManager.followTime(follow);
      replayManager.state.currentTime = 60;

      replayManager.updateReplayDisplay();
      expect(follow).toHaveBeenCalledWith(replayManager.state);

      replayManager.followTime(null);
      replayManager.updateReplayDisplay();
      expect(follow).toHaveBeenCalledOnce();
    });

    it("updates time display and slider value text", () => {
      replayManager.state.currentTime = 60;

      replayManager.updateReplayDisplay();

      expect(el("replay-time-display").textContent).toBe("1:00 / 4:00");
      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.value).toBe("60");
      expect(slider.getAttribute("aria-valuetext")).toBe("1:00 of 4:00");
    });

    it("keeps the current time out of the start of the timeline", () => {
      // It read as a second clock beside the one in the transport row
      const sliderStart = el("replay-slider-start");
      sliderStart.textContent = "0:00";
      replayManager.state.currentTime = 60;

      replayManager.updateReplayDisplay();

      expect(sliderStart.textContent).toBe("0:00");
    });

    it("gives the elapsed time the hours of a flight that has them", () => {
      // "3:26 / 3:22:57" mixed two formats in one readout
      replayManager.state.maxTime = 3 * 3600 + 22 * 60 + 57;
      replayManager.state.currentTime = 3 * 60 + 26;

      replayManager.updateReplayDisplay();

      expect(el("replay-time-display").textContent).toBe("0:03:26 / 3:22:57");
    });

    it("writes the transport row only when its text changes", () => {
      replayManager.state.currentTime = 60;
      replayManager.updateReplayDisplay();
      const timeDisplay = el("replay-time-display");
      // A sentinel survives a frame that changes nothing visible
      timeDisplay.textContent = "sentinel";

      replayManager.state.currentTime = 60.2;
      replayManager.updateReplayDisplay();

      expect(timeDisplay.textContent).toBe("sentinel");
      // The slider itself moves with the fine time value
      expect((el("replay-slider") as HTMLInputElement).value).toBe("60.2");

      replayManager.state.currentTime = 61;
      replayManager.updateReplayDisplay();

      expect(timeDisplay.textContent).toBe("1:01 / 4:00");
    });

    it("draws path segments incrementally from the last drawn index", () => {
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      expect(drawnColors()).toHaveLength(2);

      // The next frame only draws newly reached segments
      replayManager.state.currentTime = 125;
      replayManager.updateReplayDisplay();
      expect(replayManager.state.lastDrawnIndex).toBe(2);
      expect(drawnColors()).toHaveLength(3);
    });

    it("tells the map of the trail once per frame the airplane moved in", () => {
      const { trail } = replaySources(mockApp);

      // The trail ends at the airplane, so every frame it moves in is one
      // write, whether it drew a segment or not
      for (const time of [5, 10, 15, 20]) {
        replayManager.state.currentTime = time;
        replayManager.updateReplayDisplay();
        runFrame();
      }
      expect(trail.setData).toHaveBeenCalledTimes(4);

      // A frame that moves nothing, paused, writes nothing
      replayManager.updateReplayDisplay();
      runFrame();
      expect(trail.setData).toHaveBeenCalledTimes(4);

      // Several positions of a slider drag within one frame: one write
      for (const time of [65, 125]) {
        replayManager.state.currentTime = time;
        replayManager.updateReplayDisplay(true);
      }
      runFrame();
      expect(trail.setData).toHaveBeenCalledTimes(5);
      expect(featuresOf(trail)).toHaveLength(3);
    });

    it("does not draw segments when at time 0", () => {
      replayManager.state.currentTime = 0;
      replayManager.state.lastDrawnIndex = -1;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.lastDrawnIndex).toBe(-1);
    });

    it("tracks the current segment index", () => {
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.currentIndex).toBe(1);
    });

    it("positions airplane at first segment when no segment has started", () => {
      replayManager.state.currentTime = -1;
      airplane().setLatLng([0, 0]);

      replayManager.updateReplayDisplay();

      expect(airplane().getLatLng()).toEqual([48.0, 16.0]);
      expect(replayManager.state.currentIndex).toBe(-1);
    });

    it("uses airspeed colors when airspeed visible and altitude not visible", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(drawnColors()).toEqual([speedColor(100), speedColor(120)]);
    });

    it("updates airplane rotation via element transform", () => {
      replayManager.state.currentTime = 65;
      const iconDiv = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;

      replayManager.updateReplayDisplay();

      expect(iconDiv.style.transform).toMatch(
        /^translate3d\(0,0,0\) rotate\(-?[\d.]+deg\)$/,
      );
    });

    it("follows the airplane near the edge with a jump per frame", () => {
      replayManager.state.playing = true;
      replayManager.state.currentTime = 65;
      airplaneAt(10, 300);
      mockApp.map!.easeTo.mockClear();
      mockApp.map!.jumpTo.mockClear();

      replayManager.updateReplayDisplay();

      // An animation asked for on every frame starts from rest on every
      // frame, and stuttered (see ReplayCamera.trackAirplane)
      expect(mockApp.map!.jumpTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("does not pan on manual seek while the airplane is well inside the viewport", () => {
      replayManager.state.playing = false;
      replayManager.state.currentTime = 65;
      airplaneAt(400, 300);
      mockApp.map!.easeTo.mockClear();

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.jumpTo).not.toHaveBeenCalled();
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("pans without animation on manual seek when the airplane leaves the viewport", () => {
      replayManager.state.playing = false;
      replayManager.state.currentTime = 65;
      airplaneAt(-20, 300);
      mockApp.map!.easeTo.mockClear();

      replayManager.updateReplayDisplay(true);

      expect(mockApp.map!.jumpTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.jumpTo).toHaveBeenCalledWith(
        {
          center: airplane().marker.getLngLat().toArray(),
        },
        mapHelpers.REPLAY_CAMERA_MOVE,
      );
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("interpolates the position along the segment being flown", () => {
      // A segment's time is its start: segment 0 runs from [48.0, 16.0] at
      // t=0 to [48.1, 16.1] at t=60, when segment 1 starts. Halfway in time
      // the airplane is halfway along segment 0, not already on segment 1.
      replayManager.state.currentTime = 30;
      vi.mocked(airplane().marker.setLngLat).mockClear();

      replayManager.updateReplayDisplay();

      expect(airplane().marker.setLngLat).toHaveBeenCalledTimes(1);
      const [lat, lon] = positions()[0]!;
      // Give or take the few milliseconds the replay smooths the times by
      // (see replayCurve)
      expect(lat).toBeCloseTo(48.05, 4);
      expect(lon).toBeCloseTo(16.05, 4);
    });

    it("starts a segment at its first point and ends the flight at the last", () => {
      // At its time, as the replay has smoothed it (see replayCurve)
      replayManager.state.currentTime = replayManager.state.segments[1]!.time!;
      replayManager.updateReplayDisplay();
      expect(airplane().getLatLng()).toEqual([48.1, 16.1]);

      // The last segment from its start to the end of the replay
      replayManager.state.currentTime = 120;
      replayManager.updateReplayDisplay();
      expect(airplane().getLatLng()).toEqual([48.2, 16.2]);
      replayManager.state.currentTime = 180;
      replayManager.updateReplayDisplay();
      const [lat, lon] = airplane().getLatLng();
      expect(lat).toBeGreaterThan(48.2);
      expect(lat).toBeLessThan(48.3);
      expect(lon).toBeGreaterThan(16.2);
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.updateReplayDisplay();
      expect(airplane().getLatLng()).toEqual([48.3, 16.3]);
    });

    it("crosses a gap in the recording over its duration, not at its start", () => {
      replayManager.state.segments = [
        segmentOf({
          path_id: 1,
          coords: [
            [48.0, 16.0],
            [49.0, 17.0],
          ],
          time: 0,
        }),
        segmentOf({
          path_id: 1,
          coords: [
            [49.0, 17.0],
            [49.1, 17.1],
          ],
          time: 600,
        }),
      ];
      replayManager.state.currentTime = 1;
      replayManager.updateReplayDisplay(true);

      const [lat] = airplane().getLatLng();
      expect(lat).toBeLessThan(48.01);
    });

    it("moves the airplane between two frames within one segment", () => {
      replayManager.state.currentTime = 15;
      replayManager.updateReplayDisplay();
      replayManager.state.currentTime = 45;
      replayManager.updateReplayDisplay();

      const moves = positions();
      const first = moves[moves.length - 2]!;
      const second = moves[moves.length - 1]!;
      expect(second[0]).toBeGreaterThan(first[0]);
      expect(second[1]).toBeGreaterThan(first[1]);
    });

    it("rewrites the rotation only when the heading changes", () => {
      const iconDiv = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      replayManager.state.currentTime = 65;
      replayManager.updateReplayDisplay();
      const transform = iconDiv.style.transform;
      expect(transform).toContain("rotate(");

      // The same heading in a frame paused there is not written again (a
      // valid transform is used as the sentinel; jsdom drops invalid values)
      iconDiv.style.transform = "rotate(1deg)";
      replayManager.updateReplayDisplay();
      expect(iconDiv.style.transform).toBe("rotate(1deg)");

      // The airplane of the next activation gets its own lookup and write
      replayManager.initializeReplay();
      const rebuiltIcon = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      expect(rebuiltIcon).not.toBe(iconDiv);
      replayManager.state.currentTime = 65;
      replayManager.updateReplayDisplay();
      const degrees = (value: string): number =>
        Number(/rotate\(([-\d.e]+)deg\)/.exec(value)?.[1]);
      expect(degrees(rebuiltIcon.style.transform)).toBeCloseTo(
        degrees(transform),
        6,
      );
    });

    it("keeps the last heading where the flight stands still", () => {
      // Where the curve has no direction, standing and without a piece of
      // it on either side that moves
      vi.spyOn(replayFeature, "replayPoint").mockReturnValue({
        position: [48.15, 16.15],
        heightFt: 0,
        track: null,
        point: 1,
      });
      replayManager.state.lastBearing = 45;
      replayManager.state.currentTime = 65;
      const iconDiv = airplane()
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;

      replayManager.updateReplayDisplay();

      expect(replayManager.state.lastBearing).toBe(45);
      // The marker is drawn nose up, so the rotation is the bearing itself
      // (turned there from the heading before, hence the rounding)
      const degrees = /rotate\(([-\d.e]+)deg\)/.exec(iconDiv.style.transform);
      expect(Number(degrees?.[1])).toBeCloseTo(45);
    });

    it("auto-zooms out when too many recenters happen", () => {
      replayManager.state.playing = true;
      replayManager.state.autoZoom = true;
      mockApp.map!.getZoom.mockReturnValue(14);
      replayManager.state.currentTime = 65;
      airplaneAt(10, 300);
      const now = Date.now();
      replayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      replayManager.updateReplayDisplay();

      // Out onto the airplane, five seconds into the second segment
      expect(mockApp.map!.easeTo).toHaveBeenLastCalledWith({
        center: [expect.closeTo(16.1083, 3), expect.closeTo(48.1083, 3)],
        zoom: 13,
        duration: 250,
        animate: true,
      });
      expect(replayManager.state.recenterTimestamps).toEqual([]);
    });
  });

  describe("updateReplayDisplay - popup auto-update", () => {
    it("updates airplane popup when popup is open during display update", () => {
      replayManager.state.currentTime = 65;
      airplane().openPopup();

      replayManager.updateReplayDisplay();

      expect(airplane().popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          segment: replayManager.state.segments[1],
          title: "Current position",
        }),
      );
    });

    it("moves an open popup along with the airplane", () => {
      airplane().openPopup();
      replayManager.state.currentTime = 30;

      replayManager.updateReplayDisplay();

      expect(airplane().popup.getLngLat()).toEqual(
        airplane().marker.getLngLat(),
      );
    });

    it("rebuilds an open popup only when the airplane reaches another segment", () => {
      airplane().openPopup();
      const { popup } = airplane();
      vi.mocked(popup.addTo).mockClear();

      replayManager.state.currentTime = 61;
      replayManager.updateReplayDisplay();
      replayManager.state.currentTime = 62;
      replayManager.updateReplayDisplay();
      replayManager.state.currentTime = 63;
      replayManager.updateReplayDisplay();
      expect(popup.setHTML).toHaveBeenCalledTimes(1);

      replayManager.state.currentTime = 121;
      replayManager.updateReplayDisplay();
      expect(popup.setHTML).toHaveBeenCalledTimes(2);
      // Already open, so it is not opened again
      expect(popup.addTo).not.toHaveBeenCalled();
    });

    it("does not touch the popup when it is closed", () => {
      replayManager.state.currentTime = 65;

      replayManager.updateReplayDisplay();

      expect(airplane().popup.setHTML).not.toHaveBeenCalled();
      expect(airplane().isPopupOpen()).toBe(false);
    });
  });

  describe("updateReplayAirplanePopup", () => {
    it("does nothing without an airplane marker", () => {
      replayManager.state.airplaneMarker = null;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });

    it("does nothing when replay is not active", () => {
      mockApp.replayActive = false;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
      expect(airplane().isPopupOpen()).toBe(false);
    });

    it("fills the popup with the segment at the current time and opens it", () => {
      replayManager.state.currentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({
          segment: replayManager.state.segments[0],
          altRange: expect.objectContaining({
            min: 3000,
            max: 5000,
          }) as unknown,
          speedRange: expect.objectContaining({
            min: 100,
            max: 130,
          }) as unknown,
          icon: "aircraftTop",
        }),
      );
      const { popup } = airplane();
      expect(popup.getElement().innerHTML).toContain("<div>popup</div>");
      expect(airplane().isPopupOpen()).toBe(true);
      // At the airplane, and never bound to the marker: MapLibre would
      // toggle a bound popup a second time on the same click
      expect(popup.getLngLat()).toEqual(airplane().marker.getLngLat());
      expect(airplane().marker.setPopup).not.toHaveBeenCalled();
    });

    it("pans the map to show the popup only while paused", () => {
      const pan = vi.spyOn(mapHelpers, "panPopupIntoView");
      // Panning for the popup would stop the map's recenter pan each time
      replayManager.playReplay();
      replayManager.updateReplayAirplanePopup();
      expect(pan).not.toHaveBeenCalled();

      // Paused, the popup pans the map to show itself: without that a click
      // on an airplane near the top edge opened it off the map
      replayManager.pauseReplay();
      replayManager.updateReplayAirplanePopup();
      expect(pan).toHaveBeenCalledWith(
        mockApp.map,
        airplane().popup,
        undefined,
        true,
      );
    });

    it("fills and opens the popup on a click, which Enter on the button is too", () => {
      const button = airplane().getElement();
      expect(button.tagName).toBe("BUTTON");
      replayManager.state.currentTime = 30;

      button.click();

      expect(airplane().isPopupOpen()).toBe(true);
      expect(airplane().popup.getElement().innerHTML).toContain(
        "<div>popup</div>",
      );

      // The next click puts it away again
      button.click();
      expect(airplane().isPopupOpen()).toBe(false);
    });

    it("uses first segment when no segment has time <= currentTime", () => {
      replayManager.state.currentTime = -10;

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: replayManager.state.segments[0] }),
      );
    });

    it("returns early when replaySegments is empty", () => {
      replayManager.state.segments = [];

      replayManager.updateReplayAirplanePopup();

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
      expect(airplane().isPopupOpen()).toBe(false);
    });

    it("refills an open popup instead of opening it again", () => {
      airplane().openPopup();
      vi.mocked(airplane().popup.addTo).mockClear();
      replayManager.state.currentTime = 30;

      replayManager.updateReplayAirplanePopup();

      expect(airplane().popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(airplane().popup.addTo).not.toHaveBeenCalled();
    });
  });
});
