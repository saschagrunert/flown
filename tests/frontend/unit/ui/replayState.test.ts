import { describe, it, expect } from "vitest";
import {
  ReplayState,
  restingPitch,
} from "../../../../flown/frontend/ui/replayState";
import type { MapApp } from "../../../../flown/frontend/mapApp";

describe("ReplayState", () => {
  describe("default values", () => {
    it("initializes with correct defaults", () => {
      const state = new ReplayState();

      expect(state.playing).toBe(false);
      expect(state.currentTime).toBe(0);
      expect(state.maxTime).toBe(0);
      expect(state.speed).toBe(50.0);
      expect(state.layerActive).toBe(false);
      expect(state.trailRuns).toEqual([]);
      expect(state.trailDirty).toBe(false);
      expect(state.segments).toEqual([]);
      expect(state.airplaneMarker).toBeNull();
      expect(state.lastDrawnIndex).toBe(-1);
      expect(state.currentIndex).toBe(-1);
      expect(state.lastBearing).toBeNull();
      expect(state.animationFrameId).toBeNull();
      expect(state.lastFrameTime).toBeNull();
      expect(state.colorAltRange).toEqual({ min: 0, max: 10000 });
      expect(state.colorSpeedRange).toEqual({ min: 0, max: 200 });
      expect(state.autoZoom).toBe(false);
      expect(state.recenterTimestamps).toEqual([]);
      expect(state.recenterPanEndsAt).toBe(0);
      expect(state.lastSeekPanTime).toBe(0);
    });
  });

  describe("resetDrawState", () => {
    it("resets drawing-related properties", () => {
      const state = new ReplayState();
      state.currentTime = 120;
      state.lastDrawnIndex = 50;
      state.currentIndex = 50;
      state.lastBearing = 180;
      state.recenterTimestamps = [1000, 2000, 3000];
      state.recenterPanEndsAt = 3500;
      state.lastSeekPanTime = 4000;

      state.resetDrawState();

      expect(state.currentTime).toBe(0);
      expect(state.lastDrawnIndex).toBe(-1);
      expect(state.currentIndex).toBe(-1);
      expect(state.lastBearing).toBeNull();
      expect(state.recenterTimestamps).toEqual([]);
      expect(state.recenterPanEndsAt).toBe(0);
      expect(state.lastSeekPanTime).toBe(0);
    });

    it("empties the trail and marks it dirty", () => {
      const state = new ReplayState();
      state.trailRuns = [
        {
          color: "#ff0000",
          coords: [
            [16, 48],
            [16.1, 48.1],
          ],
          firstIndex: 0,
          lastIndex: 0,
        },
      ];

      state.resetDrawState();

      expect(state.trailRuns).toEqual([]);
      expect(state.trailDirty).toBe(true);
    });

    it("leaves an empty trail clean", () => {
      const state = new ReplayState();

      state.resetDrawState();

      expect(state.trailDirty).toBe(false);
    });

    it("preserves non-drawing properties", () => {
      const state = new ReplayState();
      state.playing = true;
      state.speed = 100;
      state.maxTime = 500;
      state.colorAltRange = { min: 200, max: 8000 };
      state.autoZoom = true;

      state.resetDrawState();

      expect(state.playing).toBe(true);
      expect(state.speed).toBe(100);
      expect(state.maxTime).toBe(500);
      expect(state.colorAltRange).toEqual({ min: 200, max: 8000 });
      expect(state.autoZoom).toBe(true);
    });

    it("can be called multiple times", () => {
      const state = new ReplayState();
      state.currentTime = 100;
      state.resetDrawState();
      state.currentTime = 200;
      state.resetDrawState();

      expect(state.currentTime).toBe(0);
      expect(state.lastDrawnIndex).toBe(-1);
    });
  });

  describe("restingPitch", () => {
    const appWith = (pitch: number | null, layingBack: number | null) => {
      const replayState = new ReplayState();
      replayState.layingBack = layingBack;
      const map = pitch === null ? null : { getPitch: () => pitch };
      return { map, replayState } as unknown as Pick<
        MapApp,
        "map" | "replayState"
      >;
    };

    it("is the tilt of the map, or the one it is being laid back to", () => {
      expect(restingPitch(appWith(30, null))).toBe(30);
      expect(restingPitch(appWith(30, 5))).toBe(5);
      expect(restingPitch(appWith(null, null))).toBe(0);
    });
  });
});
