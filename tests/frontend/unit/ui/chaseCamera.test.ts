import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CHASE_PITCH,
  CHASE_ZOOM,
  CHASE_ZOOM_RANGE,
  ChaseCamera,
  GLOBE_FLAT_ZOOM,
  chaseLead,
  clearPitch,
  dampStep,
  projectRelative,
  turnTime,
  type ChaseTarget,
} from "../../../../flown/frontend/ui/chaseCamera";
import { liftMetres } from "../../../../flown/frontend/calculations/lift";
import { turnOf } from "../../../../flown/frontend/utils/geometry";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Map as MockMapLibreMap } from "../../../mocks/maplibre-gl";
import { createMapLibreMock } from "../../testHelpers";

describe("dampStep", () => {
  it("closes the distance smoothly and never overshoots", () => {
    let offset = 100;
    let velocity = 0;
    const offsets: number[] = [];
    for (let i = 0; i < 120; i++) {
      const [move, v] = dampStep(offset, velocity, 1 / 60, 0.6);
      offset -= move;
      velocity = v;
      offsets.push(offset);
    }
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!).toBeLessThanOrEqual(offsets[i - 1]!);
      expect(offsets[i]!).toBeGreaterThanOrEqual(0);
    }
    // About the time it takes: over half the way in it, all of it in two
    expect(offsets[35]!).toBeLessThan(45);
    expect(offsets[119]!).toBeLessThan(1);
  });

  it("stays stable for a frame far longer than its time", () => {
    const [move] = dampStep(100, 0, 5, 0.2);
    expect(move).toBeGreaterThan(99);
    expect(move).toBeLessThanOrEqual(100);
  });
});

describe("turnTime", () => {
  it("is seconds of the flight, held between a fifth and one second", () => {
    expect(turnTime(1)).toBe(1);
    expect(turnTime(10)).toBeCloseTo(0.3);
    expect(turnTime(100)).toBe(0.2);
  });
});

describe("projectRelative", () => {
  it("is the map itself seen from straight above", () => {
    expect(projectRelative(30, 40, 0, 0, 0, 1000)).toEqual({
      x: 30,
      y: -40,
    });
  });

  it("turns with the bearing", () => {
    // Facing east, a point east of the middle is ahead, up the screen
    const p = projectRelative(50, 0, 0, 90, 0, 1000);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-50);
  });

  it("draws a height up the screen, and nearer the camera larger", () => {
    const ground = projectRelative(0, 0, 0, 0, 60, 1000);
    const up = projectRelative(0, 0, 100, 0, 60, 1000);
    expect(ground).toEqual({ x: 0, y: -0 });
    expect(up.y).toBeLessThan(-80);
    // Straight above, a height comes closer and so grows on the screen
    const beside = projectRelative(10, 0, 500, 0, 0, 1000);
    expect(beside.x).toBeCloseTo(20);
  });
});

describe("chaseLead", () => {
  it("puts a point that far behind the middle as far below it", () => {
    for (const pitch of [0, 45, 70]) {
      const lead = chaseLead(80, pitch, 1200);
      // The airplane is `lead` behind the point the camera looks at
      const drawn = projectRelative(0, -lead, 0, 0, pitch, 1200);
      expect(drawn.y).toBeCloseTo(80);
      expect(drawn.x).toBeCloseTo(0);
    }
  });

  it("looks behind the airplane to draw it above the middle", () => {
    expect(chaseLead(-50, 70, 1200)).toBeLessThan(0);
  });
});

describe("clearPitch", () => {
  const cos = (degrees: number) => Math.cos((degrees * Math.PI) / 180);
  const cot = (degrees: number) => 1 / Math.tan((degrees * Math.PI) / 180);

  it("leaves the tilt alone over low ground or none", () => {
    expect(clearPitch(1000, 3000, [])).toBe(90);
    expect(clearPitch(1000, 3000, [[2800, 200]])).toBe(90);
  });

  it("brings the camera down to where it clears a ridge under it", () => {
    // The camera 3 km away and the point it looks at 1000 m up: at 70
    // degrees the camera is 1026 m above that, too low for a 2500 m ridge
    const pitch = clearPitch(1000, 3000, [[2900, 2500]]);
    expect(pitch).toBeLessThan(70);
    expect(1000 + 3000 * cos(pitch)).toBeCloseTo(2500 + 150);
  });

  it("keeps the line of sight above the relief between", () => {
    const pitch = clearPitch(1000, 3000, [[1000, 1500]], 0);
    expect(1000 + 1000 * cot(pitch)).toBeCloseTo(1500);
    expect(1000 + 3000 * cos(pitch)).toBeGreaterThan(1500);
  });

  it("looks straight down past relief it cannot clear", () => {
    expect(clearPitch(0, 1000, [[900, 5000]])).toBe(0);
  });
});

describe("ChaseCamera", () => {
  let map: MockMapLibreMap;
  let now: number;
  const heading = (
    track: number,
    heightFt: number | null = null,
    position: [number, number] = [51.55, 12.06],
    exaggeration = 2,
  ): ChaseTarget => ({ position, track, heightFt, exaggeration });

  function camera(): ChaseCamera {
    return new ChaseCamera(map as unknown as MapLibreMap);
  }

  /** Frames of 60 per second for `seconds`, the target from `target` */
  function run(
    chase: ChaseCamera,
    seconds: number,
    target: (i: number) => ChaseTarget,
    speed = 10,
  ): boolean {
    let settled = false;
    const frames = Math.round(seconds * 60);
    for (let i = 0; i < frames; i++) {
      now += 1000 / 60;
      settled = chase.step(target(i), speed, now, false);
    }
    return settled;
  }

  beforeEach(() => {
    map = createMapLibreMock({ center: [12.06, 51.55], zoom: 12 });
    const container = map.getContainer();
    Object.defineProperty(container, "clientWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      value: 600,
      configurable: true,
    });
    now = 1000;
  });

  it("keeps the view it takes the map from, and unclamps its centre", () => {
    map.jumpTo({ bearing: 30, pitch: 40 });
    const chase = camera();
    expect(chase.saved).toEqual({
      center: { lng: 12.06, lat: 51.55 },
      zoom: 12,
      bearing: 30,
      pitch: 40,
    });
    expect(map.setCenterClampedToGround).toHaveBeenCalledWith(false);
  });

  it("flies from the map as it is into the chase, without a jump", () => {
    const chase = camera();
    run(chase, 1 / 60, () => heading(90));
    // One frame in, still close to where the map was
    expect(map.getZoom()).toBeLessThan(12.1);
    expect(map.getPitch()).toBeLessThan(5);
    expect(Math.abs(map.getBearing())).toBeLessThan(5);

    const settled = run(chase, 4, () => heading(90));
    expect(settled).toBe(true);
    expect(map.getZoom()).toBeCloseTo(CHASE_ZOOM, 2);
    expect(map.getPitch()).toBeCloseTo(CHASE_PITCH, 1);
    expect(map.getBearing()).toBeCloseTo(90, 1);
  });

  it("follows the heading into a turn, lagging it, and settles on it", () => {
    const chase = camera();
    run(chase, 4, () => heading(0));
    // A turn at three degrees a second of a replay at 10x
    const bearings: number[] = [];
    const tracks: number[] = [];
    for (let i = 0; i < 180; i++) {
      now += 1000 / 60;
      const track = Math.min(i * 0.5, 60);
      tracks.push(track);
      chase.step(heading(track), 10, now, false);
      bearings.push(map.getBearing());
    }
    // It lags into the turn
    expect(bearings[20]!).toBeLessThan(tracks[20]!);
    expect(bearings[20]!).toBeGreaterThan(0);
    for (let i = 1; i < 125; i++) {
      expect(bearings[i]!).toBeGreaterThanOrEqual(bearings[i - 1]! - 1e-9);
    }
    // In the turn it keeps up, by as much as the turn leads it
    expect(tracks[100]! - bearings[100]!).toBeLessThan(3);
    // Out of it, it settles on the heading, past which it swings by as
    // much as the turn led it by at most
    expect(Math.max(...bearings)).toBeLessThan(62);
    expect(bearings[179]!).toBeCloseTo(60, 0);
  });

  it("looks at the airplane at its height, so the zoom is its distance", () => {
    const chase = camera();
    const zooms = [0, 3000, 9000].map((heightFt) => {
      run(chase, 4, () => heading(0, heightFt));
      // The point looked at is in the air, at the airplane's height as the
      // ribbons draw it (level ground, no relief here)
      expect(map.getCenterElevation()).toBeCloseTo(liftMetres(heightFt, 2), 0);
      return map.getZoom();
    });
    // The same distance, and the same size of the airplane and the ground
    // around it, however high it flies
    for (const zoom of zooms) expect(zoom).toBeCloseTo(CHASE_ZOOM, 3);
  });

  it("lifts the airplane as much as its trail, whatever the zoom of the moment", () => {
    const chase = camera();
    // A pinch out of the chase's zoom, onto a level that lifts four times:
    // the trail keeps its level until the pinch ends, and so does the
    // airplane
    map.jumpTo({ zoom: 8 });
    chase.step(heading(0, 3000, undefined, 2), 1, (now += 16), true);

    expect(map.getCenterElevation()).toBeCloseTo(liftMetres(3000, 2), 0);
  });

  it("draws the airplane below the middle, where the camera sees it", () => {
    const chase = camera();
    const target = heading(0, 2000);
    run(chase, 4, () => target);
    const [x, y] = chase.offsetOf(target);
    const ground = map.project([12.06, 51.55]);
    // At CHASE_SCREEN_Y of the map above the replay panel (none here)
    expect(ground.x + x).toBeCloseTo(400, 0);
    expect(ground.y + y).toBeCloseTo(0.6 * 600, 0);
  });

  it("keeps the airplane by the camera past 180, the map's centre wrapped back", () => {
    /**
     * Where the airplane is drawn after a chase step from `center` towards
     * a flight at `lng` heading east, a new chase from the map there
     */
    const drawnAt = (lng: number, center: number): [number, number] => {
      map.jumpTo({ center: [center, 10], zoom: 12, bearing: 0, pitch: 0 });
      const chase = camera();
      const target = heading(90, 2000, [10, lng]);
      chase.step(target, 10, (now += 16), false);
      // Wrapped back into -180 to 180, as MapLibre does as the map moves
      const { lng: moved, lat } = map.getCenter();
      map.jumpTo({ center: [moved - 360 * Math.round(moved / 360), lat] });
      const [x, y] = chase.offsetOf(target);
      const centre = map.getCenter().lng;
      const ground = map.project([centre + turnOf(centre, lng), 10]);
      return [ground.x + x, ground.y + y];
    };
    // A replay going on past 180, the map's centre a drag later wrapped
    // back west of it, against the same chase by a flight far from 180
    const [x, y] = drawnAt(180.01, -179.99);
    const [farX, farY] = drawnAt(20.01, 20.01);
    expect(x).toBeCloseTo(farX, 0);
    expect(y).toBeCloseTo(farY, 0);
  });

  /** A replay panel whose top is `top` pixels down the page */
  function panelAt(top: number): { moveTo: (top: number) => void } {
    const panel = document.createElement("div");
    panel.id = "replay-controls";
    document.body.append(panel);
    let at = top;
    panel.getBoundingClientRect = () => ({ top: at }) as DOMRect;
    return { moveTo: (top) => (at = top) };
  }

  afterEach(() => {
    document.getElementById("replay-controls")?.remove();
  });

  it("keeps the airplane above the replay panel after the map resizes", () => {
    const panel = panelAt(600);
    const onChange = vi.fn();
    const chase = new ChaseCamera(map as unknown as MapLibreMap, onChange);
    const target = heading(0, 2000);
    run(chase, 4, () => target);
    const drawnY = () =>
      map.project([12.06, 51.55]).y + chase.offsetOf(target)[1];
    expect(drawnY()).toBeCloseTo(0.6 * 600, 0);

    // A phone turned: the panel now covers the lower third of the map
    panel.moveTo(400);
    map.emit("resize");
    expect(onChange).toHaveBeenCalledTimes(1);
    run(chase, 4, () => target);
    expect(drawnY()).toBeCloseTo(0.6 * 400, 0);

    chase.release();
    map.emit("resize");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("lays the page out in no frame but the first and those after a resize", () => {
    // Asking the size of the map's container or of the panel lays the page
    // out, which on a phone took half a second of a frame (see mapSize)
    panelAt(500);
    const container = map.getContainer();
    const reads = vi.fn();
    const measured = (value: number) => ({
      get: () => {
        reads();
        return value;
      },
    });
    Object.defineProperty(container, "clientWidth", measured(800));
    Object.defineProperty(container, "clientHeight", measured(600));
    const boxes = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const panelBox = vi.spyOn(
      document.getElementById("replay-controls")!,
      "getBoundingClientRect",
    );
    const chase = camera();
    const target = heading(0, 2000);
    run(chase, 1 / 60, () => target);
    chase.offsetOf(target);
    expect(reads).toHaveBeenCalled();
    reads.mockClear();
    boxes.mockClear();
    panelBox.mockClear();

    run(chase, 1, () => target);
    for (let i = 0; i < 10; i++) chase.offsetOf(target);
    expect(reads).not.toHaveBeenCalled();
    expect(boxes).not.toHaveBeenCalled();
    expect(panelBox).not.toHaveBeenCalled();

    // After a resize the next frame measures again, and only that one
    map.emit("resize");
    run(chase, 1, () => target);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(panelBox).toHaveBeenCalledTimes(1);
    boxes.mockRestore();
  });

  it("measures again when the replay panel changes its height", () => {
    const observers: { callback: () => void; disconnect: () => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(readonly callback: () => void) {
          observers.push(this);
        }
      },
    );
    const panel = panelAt(600);
    const onChange = vi.fn();
    const chase = new ChaseCamera(map as unknown as MapLibreMap, onChange);
    const target = heading(0, 2000);
    run(chase, 4, () => target);
    expect(observers).toHaveLength(1);

    panel.moveTo(450);
    observers[0]!.callback();
    expect(onChange).toHaveBeenCalledTimes(1);
    run(chase, 4, () => target);
    const [, y] = chase.offsetOf(target);
    expect(map.project([12.06, 51.55]).y + y).toBeCloseTo(0.6 * 450, 0);

    chase.release();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it("never swings the wrong way at a jump of the heading", () => {
    const chase = camera();
    run(chase, 4, () => heading(0));
    // The heading jumps by 60 degrees within a frame the longest there is
    // (0.1 s) at 10x, as it does at a stop: no turn to lead by 180 degrees
    const bearings: number[] = [];
    for (let i = 0; i < 60; i++) {
      now += 100;
      chase.step(heading(60), 10, now, false);
      bearings.push(map.getBearing());
    }
    for (const bearing of bearings) {
      expect(turnOf(0, bearing)).toBeGreaterThanOrEqual(0);
      expect(turnOf(0, bearing)).toBeLessThan(60 + 45);
    }
    expect(bearings.at(-1)!).toBeCloseTo(60, 1);
  });

  it("zooms out no further than where the globe is flat", () => {
    const chase = camera();
    run(chase, 4, () => heading(0));
    // The user zooms out as far as the chase goes on the flat map
    map.jumpTo({ zoom: 10 });
    chase.resume();
    run(chase, 4, () => heading(0));
    expect(map.getZoom()).toBeCloseTo(CHASE_ZOOM_RANGE[0], 2);

    // The globe switched on during the chase
    map.setProjection({ type: "globe" });
    expect(run(chase, 4, () => heading(0))).toBe(true);
    expect(map.getZoom()).toBeCloseTo(GLOBE_FLAT_ZOOM, 2);

    map.setProjection({ type: "mercator" });
    run(chase, 4, () => heading(0));
    expect(map.getZoom()).toBeCloseTo(CHASE_ZOOM_RANGE[0], 2);
  });

  it("puts everything in place at once for a seek", () => {
    const chase = camera();
    now += 16;
    expect(chase.step(heading(200), 10, now, true)).toBe(true);
    expect(turnOf(map.getBearing(), 200)).toBeCloseTo(0);
    expect(map.getPitch()).toBeCloseTo(CHASE_PITCH);
    expect(map.getZoom()).toBeCloseTo(CHASE_ZOOM);
  });

  it("tilts down steeper than it would, to stay above a ridge behind", () => {
    map.terrain = { source: "terrain" };
    const chase = camera();
    run(chase, 4, () => heading(0, 1000));
    expect(map.getPitch()).toBeCloseTo(CHASE_PITCH, 1);

    // A ridge rises behind the airplane, south of it, 600 m above it
    const airplaneM = map.getCenterElevation();
    const ridgeM = airplaneM + 600;
    const groundAt = (lat: number) => (lat < 51.545 ? ridgeM : 0);
    map.queryTerrainElevation.mockImplementation((lngLat: unknown) =>
      groundAt((lngLat as [number, number])[1]),
    );
    run(chase, 4, () => heading(0, 1000));
    const pitch = map.getPitch();
    expect(pitch).toBeLessThan(CHASE_PITCH - 5);
    // The camera, the zoom's distance behind the point it looks at, is
    // above the relief under it
    const metresPerPx =
      (40075016.686 * Math.cos((51.55 * Math.PI) / 180)) /
      (512 * 2 ** map.getZoom());
    const distanceM =
      (600 / 2 / Math.tan((36.87 * Math.PI) / 360)) * metresPerPx;
    const radians = (pitch * Math.PI) / 180;
    const cameraLat =
      map.getCenter().lat - (distanceM * Math.sin(radians)) / 111320;
    const cameraM = map.getCenterElevation() + distanceM * Math.cos(radians);
    expect(cameraM).toBeGreaterThan(groundAt(cameraLat) + 150 - 1);
  });

  it("starts from the user's view after they moved the map, keeping their zoom", () => {
    const chase = camera();
    run(chase, 4, () => heading(0));
    // The user zooms in and tilts further, beyond what the chase keeps
    map.jumpTo({ zoom: 18, pitch: 30, bearing: 120 });
    chase.resume();
    run(chase, 1 / 60, () => heading(0));
    // From there, not a jump back
    expect(map.getBearing()).toBeGreaterThan(100);
    run(chase, 4, () => heading(0));
    expect(map.getZoom()).toBeCloseTo(CHASE_ZOOM_RANGE[1], 2);
    expect(map.getPitch()).toBeCloseTo(45, 1);
    expect(map.getBearing()).toBeCloseTo(0, 1);
  });

  it("tags the jumps of its frames, which the app's handlers at rest skip", () => {
    const chase = camera();
    run(chase, 0.05, () => heading(0, 3000));

    expect(map.jumpTo).toHaveBeenCalledTimes(3);
    for (const [, eventData] of vi.mocked(map.jumpTo).mock.calls) {
      expect(eventData).toBe(REPLAY_CAMERA_MOVE);
    }
  });

  it("gives the map back clamped to the ground, seen from where it was", () => {
    const chase = camera();
    run(chase, 4, () => heading(0, 3000));
    vi.mocked(map.jumpTo).mockClear();
    chase.release();
    expect(map.setCenterClampedToGround).toHaveBeenLastCalledWith(true);
    // Without relief the map would drop its centre to sea level on the next
    // frame: the same view is handed over with a centre down there
    expect(map.calculateCameraOptionsFromTo).toHaveBeenCalledTimes(1);
    const [, altitude, , altitudeTo]: unknown[] =
      map.calculateCameraOptionsFromTo.mock.calls[0]!;
    expect(altitude).toBeGreaterThan(liftMetres(3000, 2));
    expect(altitudeTo).toBe(0);
    expect(map.jumpTo).toHaveBeenCalledTimes(1);
  });

  it("leaves the centre to the map's own easing over relief", () => {
    map.terrain = { source: "terrain" };
    const chase = camera();
    run(chase, 1, () => heading(0, 3000));
    chase.release();
    expect(map.setCenterClampedToGround).toHaveBeenLastCalledWith(true);
    expect(map.calculateCameraOptionsFromTo).not.toHaveBeenCalled();
  });
});
