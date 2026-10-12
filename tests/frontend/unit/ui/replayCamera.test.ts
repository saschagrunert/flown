/**
 * The replay's camera (ui/replayCamera.ts) apart from the map: the heading
 * of the airplane's icon, the steps of the zoom out, the room a lift has
 * on a tilted map, and the follow of a point that stands
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  followStep,
  iconHeading,
  liftRoomPx,
  unwrapRotation,
  zoomOutSteps,
} from "../../../../flown/frontend/ui/replayCamera";
import type { Map as MapLibreMap } from "maplibre-gl";
import { createMapLibreMock } from "../../testHelpers";
import type { Map as MockMapLibreMap } from "../../../mocks/maplibre-gl";

describe("unwrapRotation", () => {
  it("takes the first heading as it is", () => {
    expect(unwrapRotation(null, 300)).toBe(300);
  });

  it("turns the short way across north in both directions", () => {
    expect(unwrapRotation(350, 10)).toBe(370);
    expect(unwrapRotation(10, 350)).toBe(-10);
    expect(unwrapRotation(-45, 314)).toBe(-46);
  });

  it("keeps turning from an angle that has already wrapped", () => {
    expect(unwrapRotation(725, 10)).toBe(730);
  });
});

describe("iconHeading", () => {
  let map: MockMapLibreMap;
  const heading = (track: number): number =>
    iconHeading(map as unknown as MapLibreMap, [0, 0], track);

  beforeEach(() => {
    map = createMapLibreMock();
  });

  it("is the track itself on a flat map that is north up", () => {
    expect(heading(19)).toBe(19);
    expect(heading(250)).toBe(250);
    // Nothing to measure, so the map is not asked
    expect(map.project).not.toHaveBeenCalled();
  });

  it("takes the bearing of a turned map off the track", () => {
    map.jumpTo({ bearing: 120 });

    expect(heading(19)).toBeCloseTo(-101, 6);
    // East is up on this map, so north is to the left
    map.jumpTo({ bearing: 90 });
    expect(heading(0)).toBeCloseTo(-90, 6);
    expect(heading(90)).toBeCloseTo(0, 6);
  });

  it("draws an upright airplane along its track as the tilt shows it", () => {
    map.jumpTo({ bearing: 240, pitch: 70 });
    const upright = (track: number): number =>
      iconHeading(map as unknown as MapLibreMap, [0, 0], track, true);
    // Along the view it points ahead, never back down the screen, and
    // without asking the ground, which a slope turned the wrong way round
    expect(upright(240)).toBeCloseTo(0, 6);
    expect(upright(250)).toBeGreaterThan(10);
    expect(upright(250)).toBeLessThan(90);
    expect(upright(330)).toBeCloseTo(90, 6);
    expect(map.project).not.toHaveBeenCalled();
  });

  it("leaves the foreshortening of a tilted map to the marker's own tilt", () => {
    // At 60 degrees a north-east track runs 63 degrees off the vertical on
    // screen. The marker lies on the map and MapLibre tilts it back by the
    // same 60, so the icon itself is turned by the angle on the ground
    map.jumpTo({ pitch: 60 });

    expect(heading(45)).toBeCloseTo(45, 3);
    expect(heading(0)).toBeCloseTo(0, 6);
    expect(heading(90)).toBeCloseTo(90, 6);
    map.jumpTo({ pitch: 60, bearing: 30 });
    expect(heading(45)).toBeCloseTo(15, 3);
  });

  it("measures on a globe even when it is north up and flat", () => {
    map.setProjection({ type: "globe" });
    // The airplane is 60 degrees of longitude east of the centre, where the
    // globe of the mock draws east and west half as long as at the centre
    // and north and south as long as ever: a north-east track points 27
    // degrees off the vertical. The track itself, 45, would be wrong.
    // Zoomed in, where the few pixels the heading is measured over are a
    // short way on the ground.
    map.jumpTo({ center: [-60, 0], zoom: 10 });

    expect(heading(45)).toBeCloseTo(26.565, 1);
    expect(heading(0)).toBeCloseTo(0, 6);
  });

  it("falls back to the track less the bearing where the map cannot tell", () => {
    // Both ends of the probe on one pixel, as right at a pole
    map.jumpTo({ bearing: 30 });
    map.project.mockReturnValue({ x: 5, y: 5 });

    expect(heading(100)).toBe(70);
  });
});

describe("zoomOutSteps", () => {
  const size = { x: 800, y: 600 };

  it("takes one level while the airplane is at most twice as far out", () => {
    expect(zoomOutSteps({ x: 400, y: 300 }, size)).toBe(1);
    expect(zoomOutSteps({ x: -10, y: 300 }, size)).toBe(1);
    expect(zoomOutSteps({ x: 400, y: -300 }, size)).toBe(1);
  });

  it("takes a level for every further doubling", () => {
    expect(zoomOutSteps({ x: 400, y: -301 }, size)).toBe(2);
    expect(zoomOutSteps({ x: 2200, y: 300 }, size)).toBe(3);
  });

  it("stays within four levels", () => {
    expect(zoomOutSteps({ x: 400, y: -100_000 }, size)).toBe(4);
  });

  it("takes one level for a map without a size", () => {
    expect(zoomOutSteps({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(1);
  });
});

describe("liftRoomPx", () => {
  // MapLibre's field of view, and the camera 900 px from a 600 px screen
  const FOV = 36.87;

  it("reaches as far as the ground five degrees short of straight below the camera", () => {
    // Tilted by 60 degrees, the middle is seen 60 degrees from straight
    // down: 55 are left
    expect(liftRoomPx(60, FOV, 600)).toBeCloseTo(
      900 * Math.tan((55 * Math.PI) / 180),
      0,
    );
    expect(liftRoomPx(70, FOV, 600)).toBeCloseTo(
      900 * Math.tan((65 * Math.PI) / 180),
      0,
    );
  });

  it("leaves none on a map seen from straight above, which lifts nothing", () => {
    expect(liftRoomPx(0, FOV, 600)).toBe(0);
    expect(liftRoomPx(5, FOV, 600)).toBe(0);
  });
});

describe("followStep", () => {
  /** Where a camera that follows a point 100 px away is, frame by frame */
  function follow(frames: number, dt: number): number[] {
    let at = 0;
    let velocity = { x: 0, y: 0 };
    return Array.from({ length: frames }, () => {
      const step = followStep({ x: 100 - at, y: 0 }, velocity, dt);
      at += step.move.x;
      velocity = step.velocity;
      return at;
    });
  }

  it.each([
    ["short", 1 / 60, 120],
    ["long", 0.1, 20],
  ])(
    "catches up with a point that stands, without overshooting it, in %s frames",
    (_, dt, frames) => {
      const path = follow(frames, dt);
      path.forEach((at, i) => {
        expect(at).toBeGreaterThanOrEqual(i > 0 ? path[i - 1]! : 0);
        expect(at).toBeLessThanOrEqual(100);
      });
      expect(path[path.length - 1]).toBeGreaterThan(99);
    },
  );

  it("starts from rest", () => {
    const [first, second] = follow(2, 1 / 60);
    // Less than a pixel in the first frame, then more
    expect(first).toBeLessThan(1);
    expect(second! - first!).toBeGreaterThan(first!);
  });
});
