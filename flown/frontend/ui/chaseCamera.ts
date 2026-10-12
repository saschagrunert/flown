/**
 * Chase Camera - The replay seen from behind and above the airplane, turning
 * with it, the way a chase plane sees it (issue #300).
 *
 * The camera looks at a point in the air, at the airplane's height as the
 * map draws it (`elevation`), so its distance to the airplane is the zoom's
 * and stays the same over a valley and a ridge alike; looking at the ground
 * under it instead, a flight two kilometres up would be seen from twice as
 * far. That takes the map's own clamping of the centre to the ground off
 * while it chases. Where it looks, its bearing, tilt and zoom each follow
 * as the damped spring of the follow pan (see dampStep): a frame asks for
 * one jump, never an animation, which started from rest on every frame.
 */
import { LngLat, type Map as MapLibreMap } from "maplibre-gl";
import { MAX_FRAME_S } from "../utils/constants";
import {
  DEGREES_TO_RADIANS as RAD,
  focalLengthPx,
  TILE_SIZE_PX,
  turnOf,
} from "../utils/geometry";
import { lngLatOfMercator, mercatorOf } from "../utils/mercator";
import {
  hasLostContext,
  mapSize,
  REPLAY_CAMERA_MOVE,
} from "../utils/mapHelpers";
import { mercatorUnitMetres } from "./glLayer";
import {
  heightAtZoomFt,
  type GroundedHeight,
} from "../calculations/airplaneLift";
import { liftMetres } from "../calculations/lift";

/**
 * How far the chase tilts the map, in degrees: well into the horizon, and
 * below where MapLibre fetches ever coarser tiles towards the vanishing
 * point over a whole flight (see MAP_MAX_PITCH)
 */
export const CHASE_PITCH = 70;

/** The tilt and the map zoom the chase keeps what the user's hand left */
const CHASE_PITCH_RANGE: readonly [number, number] = [45, 75];
/**
 * Below the zoom the flights are drawn flat again at (LIFT_MAX_ZOOM), and
 * within the last relief level (see reliefLevel), with room to spare: the
 * exaggeration is the same at every zoom the chase keeps
 */
export const CHASE_ZOOM_RANGE: readonly [number, number] = [11, 16];

/**
 * The map zoom from which MapLibre's globe is drawn flat (Mercator): it
 * bends into a globe between 12 and 11. The chase's maths are the flat
 * map's, so on the globe it zooms out no further; below it the airplane
 * would be drawn away from its trail, and the view would jump as the
 * chase gives the map back.
 */
export const GLOBE_FLAT_ZOOM = 12;

/**
 * The map zoom the chase flies at: a camera about two kilometres from the
 * airplane on a map of phone height, close enough to see the roads and the
 * fields it passes and far enough to see where it goes
 */
export const CHASE_ZOOM = 14.5;

/**
 * Where the airplane is drawn, as a share of the map's height above the
 * replay panel: below the middle, so more of the view is ahead of it
 */
const CHASE_SCREEN_Y = 0.6;

/** About the time the camera takes to settle after a change (s) */
const CHASE_TIME_S = 0.6;

/**
 * The time the camera takes into a turn, in seconds of the flight: a chase
 * plane that lags a turn by a few degrees. Held between a fifth of a second
 * and a second of the replay, so a fast one does not swing behind the turn
 * by half of it, nor a slow one drift behind the airplane for seconds.
 */
const CHASE_TURN_FLIGHT_S = 3;
const CHASE_TURN_S: readonly [number, number] = [0.2, 1];

/**
 * The most the camera leads a turn by (degrees). A standard turn at 50x
 * leads it by 30; a faster replay, or a jump of the heading that is no
 * turn at all (a stop, which is no seek), would lead it by half the way
 * round or more, where the short way to the bearing it leads to is the
 * wrong one and the camera would swing away from the turn.
 */
const CHASE_MAX_LEAD = 45;

/**
 * Metres the camera keeps above the relief behind the airplane, as drawn
 * (exaggerated): it tilts down steeper rather than fly into a ridge
 */
const CHASE_CLEARANCE_M = 150;

/**
 * One frame of a critically damped spring that takes about `time` seconds:
 * `offset` is how far the target is, `velocity` the speed from the frame
 * before, `dt` the time of the frame. Returns how far to move, and the
 * speed now. The spring of Game Programming Gems 4 (1.10), which is stable
 * for any length of frame; it speeds up and slows down smoothly and never
 * overshoots.
 */
export function dampStep(
  offset: number,
  velocity: number,
  dt: number,
  time: number,
): [move: number, velocity: number] {
  const omega = 2 / time;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const temp = (velocity - omega * offset) * dt;
  return [offset + (temp - offset) * decay, (velocity - omega * temp) * decay];
}

/** How long the camera takes into a turn at a replay speed (see above) */
export function turnTime(speed: number): number {
  return Math.min(
    Math.max(CHASE_TURN_FLIGHT_S / speed, CHASE_TURN_S[0]),
    CHASE_TURN_S[1],
  );
}

/**
 * Where a point is drawn, from the point the camera looks at: `east`,
 * `north` and `up` of it in pixels of the map there, seen at `bearing` and
 * `pitch` (degrees) from `distance` pixels away, which is how MapLibre
 * places its camera. Returns the pixels right of and below that point on
 * the screen. The map's own `project` has no height but the ground's.
 */
export function projectRelative(
  east: number,
  north: number,
  up: number,
  bearing: number,
  pitch: number,
  distance: number,
): { x: number; y: number } {
  const b = bearing * RAD;
  const p = pitch * RAD;
  const right = east * Math.cos(b) - north * Math.sin(b);
  const ahead = east * Math.sin(b) + north * Math.cos(b);
  const depth = distance + ahead * Math.sin(p) - up * Math.cos(p);
  return {
    x: (distance * right) / depth,
    y: (-distance * (ahead * Math.cos(p) + up * Math.sin(p))) / depth,
  };
}

/**
 * How far ahead of the airplane, in pixels of the map, the camera looks,
 * for the airplane to be drawn `below` pixels under the middle of the map
 * (see projectRelative, solved for a point on the ground straight behind)
 */
export function chaseLead(
  below: number,
  pitch: number,
  distance: number,
): number {
  const p = pitch * RAD;
  return (below * distance) / (distance * Math.cos(p) + below * Math.sin(p));
}

/**
 * The steepest tilt, in degrees, that keeps the camera and its line of
 * sight `clearance` metres above the relief behind the point it looks at,
 * `elevation` metres up, from `distanceM` away. `ground` holds the relief
 * as `[metres back, metres up]`. The line of sight rises from that point
 * by the cotangent of the tilt, as far back as the camera, which is the
 * distance's cosine up; relief further back than the camera is held under
 * the camera, which is what a tilt the relief brings down would bring over
 * it.
 */
export function clearPitch(
  elevation: number,
  distanceM: number,
  ground: readonly (readonly [back: number, metres: number])[],
  clearance = CHASE_CLEARANCE_M,
): number {
  let pitch = 90;
  for (const [back, metres] of ground) {
    const above = metres + clearance - elevation;
    if (above <= 0) continue;
    pitch = Math.min(
      pitch,
      Math.atan2(back, above) / RAD,
      Math.acos(Math.min(above / distanceM, 1)) / RAD,
    );
  }
  return pitch;
}

/** The camera to give back once the chase ends */
export interface SavedCamera {
  center: { lng: number; lat: number };
  zoom: number;
  bearing: number;
  pitch: number;
}

/**
 * Where the airplane is and where it heads (see AirplaneHeading), and its
 * height above the flight's ground, null while the trail is flat
 */
export interface ChaseTarget extends GroundedHeight {
  position: readonly [lat: number, lon: number];
  track: number;
  /**
   * How much the height is exaggerated: the relief's, which keeps its level
   * until a zoom ends, as the trail does (see liftExaggeration)
   */
  exaggeration: number;
}

/** A value the camera follows, and its speed */
interface Spring {
  value: number;
  velocity: number;
}

const spring = (value: number): Spring => ({ value, velocity: 0 });

/**
 * A difference of Mercator x the short way round the world: a replay goes
 * on past 180 where a flight crosses it, and the map wraps its centre back
 * as it is dragged, which put the airplane a world away from the centre
 */
function worldOffset(dx: number): number {
  return dx - Math.round(dx);
}

/**
 * The camera of one chase, from the moment it takes the map until it gives
 * it back (see ReplayCamera). Its springs start from the map as it is, so
 * the chase flies into its view, and do so again after the user has moved
 * the map: what they left of the zoom and the tilt is kept.
 */
export class ChaseCamera {
  /** The camera before the chase took the map */
  readonly saved: SavedCamera;
  private bearing = spring(0);
  private pitch = spring(0);
  private zoom = spring(0);
  /**
   * Where the camera looks from where it is to look, in shares of the
   * world (Mercator), and how far above: all at rest once it follows
   */
  private x = spring(0);
  private y = spring(0);
  private z = spring(0);
  /** The zoom and the tilt the chase settles at */
  private zoomGoal = CHASE_ZOOM;
  private pitchGoal = CHASE_PITCH;
  /** The track of the frame before, whose turn the camera leads by */
  private track: number | null = null;
  /** Wall-clock time of the frame before, 0 before the first */
  private at = 0;
  /** Whether the springs start from the map at the next frame */
  private seeding = true;
  /** Pixels between the top of the map and the replay panel */
  private visibleHeight = 0;
  /** Whether visibleHeight is to be measured again at the next frame */
  private measured = false;
  /** Watches the replay panel, whose height moves the airplane */
  private readonly panelWatch: ResizeObserver | null = null;

  /**
   * The map or the replay panel changed size (a phone turned, a window
   * resized): the height between them is measured again at the next
   * frame, which `onChange` asks for, as a paused replay has none coming
   */
  private readonly onResize = (): void => {
    this.measured = false;
    this.onChange?.();
  };

  /**
   * `saved` is the camera to give back in the end, when it is not the
   * map's: one a chase before is still easing back to
   */
  constructor(
    private readonly map: MapLibreMap,
    private readonly onChange?: () => void,
    saved?: SavedCamera,
  ) {
    const center = map.getCenter();
    this.saved = saved ?? {
      center: { lng: center.lng, lat: center.lat },
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
    map.setCenterClampedToGround(false);
    map.on("resize", this.onResize);
    const panel = document.getElementById("replay-controls");
    if (panel && typeof ResizeObserver !== "undefined") {
      this.panelWatch = new ResizeObserver(this.onResize);
      this.panelWatch.observe(panel);
    }
  }

  /**
   * The user has moved the map: the next frame starts from where they left
   * it, at the zoom and the tilt they left, within the chase's
   */
  resume(): void {
    const clamp = (value: number, [low, high]: readonly [number, number]) =>
      Math.min(Math.max(value, low), high);
    this.zoomGoal = clamp(this.map.getZoom(), CHASE_ZOOM_RANGE);
    this.pitchGoal = clamp(this.map.getPitch(), CHASE_PITCH_RANGE);
    this.seeding = true;
    this.measured = false;
  }

  /**
   * Pixels a map pixel is, and the camera's distance in pixels. Asked in
   * every frame, so of the map's size and not its container's, whose size
   * lays the page out (see mapSize).
   */
  private scale(zoom: number): { world: number; distance: number } {
    const { height } = mapSize(this.map);
    return {
      world: TILE_SIZE_PX * 2 ** zoom,
      distance: focalLengthPx(height, this.map.getVerticalFieldOfView() * RAD),
    };
  }

  /**
   * Metres of height a map pixel is at `lat` and `world` pixels around, on
   * the sphere MapLibre measures the elevation on
   */
  private static metresPerPx(lat: number, world: number): number {
    return mercatorUnitMetres(lat) / world;
  }

  /**
   * The airplane's height as the map draws it, in metres above the sea:
   * over the relief under it at the map's zoom, at the relief's
   * exaggeration, which a pinch across a relief level leaves until it ends
   */
  private altitude(target: ChaseTarget): number {
    const [lat, lon] = target.position;
    const zoom = this.map.getZoom();
    const heightFt = heightAtZoomFt(target, zoom);
    return (
      (this.map.queryTerrainElevation([lon, lat]) ?? 0) +
      (heightFt === null ? 0 : liftMetres(heightFt, target.exaggeration))
    );
  }

  /**
   * Move the camera one frame after the airplane. `speed` is the replay's,
   * `now` the wall-clock time; `snap` puts it where it is to be at once,
   * for a seek. Returns whether it has come to rest there.
   */
  step(
    target: ChaseTarget,
    speed: number,
    now: number,
    snap: boolean,
  ): boolean {
    const map = this.map;
    const [lat] = target.position;
    const altitude = this.altitude(target);
    const seeding = this.seeding;
    if (seeding) {
      this.seeding = false;
      this.bearing = spring(map.getBearing());
      this.pitch = spring(map.getPitch());
      this.zoom = spring(map.getZoom());
      this.track = null;
      this.at = 0;
    }
    if (!this.measured) {
      // Measured once, and again after a resize, not on every frame: it
      // lays the page out
      this.measured = true;
      const top = map.getContainer().getBoundingClientRect().top;
      const panel = document
        .getElementById("replay-controls")
        ?.getBoundingClientRect().top;
      const { height } = mapSize(map);
      this.visibleHeight =
        panel && panel > top ? Math.min(panel - top, height) : height;
    }
    const dt = this.at
      ? Math.min(Math.max((now - this.at) / 1000, 1e-3), MAX_FRAME_S)
      : 1 / 60;
    this.at = now;

    // The turn, led by as much as the airplane turns in the time the camera
    // takes, so it lags into a turn and not through the whole of it
    const turnS = turnTime(speed);
    const rate =
      this.track === null || snap ? 0 : turnOf(this.track, target.track) / dt;
    this.track = target.track;
    const lead = Math.min(
      Math.max(rate * turnS, -CHASE_MAX_LEAD),
      CHASE_MAX_LEAD,
    );
    const turn = turnOf(this.bearing.value, target.track + lead);
    this.follow(this.bearing, turn, dt, turnS, snap);
    // Asked on every frame: the globe can be switched on during a chase
    const zoomGoal =
      map.getProjection()?.type === "globe"
        ? Math.max(this.zoomGoal, GLOBE_FLAT_ZOOM)
        : this.zoomGoal;
    this.follow(this.zoom, zoomGoal - this.zoom.value, dt, CHASE_TIME_S, snap);

    const { world, distance } = this.scale(this.zoom.value);
    const metresPerPx = ChaseCamera.metresPerPx(lat, world);
    const b = this.bearing.value * RAD;
    const { height } = mapSize(map);
    const ahead =
      chaseLead(
        CHASE_SCREEN_Y * this.visibleHeight - height / 2,
        this.pitch.value,
        distance,
      ) / world;
    const [ax, ay] = mercatorOf(target.position);
    // Where the camera is to look: ahead of the airplane, at its height
    const cx = ax + ahead * Math.sin(b);
    const cy = ay - ahead * Math.cos(b);

    if (seeding) {
      // From where the map looks now
      const center = map.getCenter();
      const [mx, my] = mercatorOf([center.lat, center.lng]);
      this.x = spring(worldOffset(mx - cx));
      this.y = spring(my - cy);
      this.z = spring(map.getCenterElevation() - altitude);
    }
    this.follow(this.x, -this.x.value, dt, CHASE_TIME_S, snap);
    this.follow(this.y, -this.y.value, dt, CHASE_TIME_S, snap);
    this.follow(this.z, -this.z.value, dt, CHASE_TIME_S, snap);
    const [lng, lookLat] = lngLatOfMercator(
      cx + this.x.value,
      cy + this.y.value,
    );
    const elevation = altitude + this.z.value;

    // Tilted no further than keeps the camera above the relief behind.
    // Looked for where the camera is at the chase's own tilt, the furthest
    // back it goes: where it is now would move as the tilt gives way, and
    // with it what the tilt has to clear.
    const distanceM = distance * metresPerPx;
    const back = (distance * Math.sin(this.pitchGoal * RAD)) / world;
    const ground: [number, number][] = [];
    for (const share of [1 / 3, 2 / 3, 1]) {
      const metres = map.queryTerrainElevation(
        lngLatOfMercator(
          cx - share * back * Math.sin(b),
          cy + share * back * Math.cos(b),
        ),
      );
      if (metres !== null) {
        ground.push([share * back * world * metresPerPx, metres]);
      }
    }
    const goal = Math.min(
      this.pitchGoal,
      clearPitch(elevation, distanceM, ground),
    );
    this.follow(this.pitch, goal - this.pitch.value, dt, CHASE_TIME_S, snap);
    // However far behind the spring is, never into the ground
    this.pitch.value = Math.min(
      this.pitch.value,
      clearPitch(elevation, distanceM, ground, 0),
    );

    // Tagged: what the app does at rest waits for the camera's own rest
    // (see ReplayCamera)
    map.jumpTo(
      {
        center: [lng, lookLat],
        elevation,
        zoom: this.zoom.value,
        bearing: this.bearing.value,
        pitch: this.pitch.value,
      },
      REPLAY_CAMERA_MOVE,
    );

    const still = (s: Spring, within: number) => Math.abs(s.velocity) < within;
    return (
      Math.hypot(this.x.value, this.y.value) * world < 0.5 &&
      Math.abs(this.z.value) < 1 &&
      Math.abs(turnOf(this.bearing.value, target.track)) < 0.1 &&
      Math.abs(goal - this.pitch.value) < 0.05 &&
      Math.abs(zoomGoal - this.zoom.value) < 0.005 &&
      still(this.bearing, 0.1) &&
      still(this.pitch, 0.05) &&
      still(this.zoom, 0.005)
    );
  }

  /** Move a spring by one frame towards `offset` from it, or all the way */
  private follow(
    s: Spring,
    offset: number,
    dt: number,
    time: number,
    snap: boolean,
  ): void {
    if (snap) {
      s.value += offset;
      s.velocity = 0;
      return;
    }
    const [move, velocity] = dampStep(offset, s.velocity, dt, time);
    s.value += move;
    s.velocity = velocity;
  }

  /**
   * Where the airplane is drawn, from where the map puts the marker: at
   * the ground under it. The chase looks at a point in the air, which the
   * map's `project` cannot answer for, so the camera's own geometry does.
   */
  offsetOf(target: ChaseTarget): [x: number, y: number] {
    const map = this.map;
    const [lat, lon] = target.position;
    const zoom = map.getZoom();
    const { world, distance } = this.scale(zoom);
    const center = map.getCenter();
    const [ax, ay] = mercatorOf(target.position);
    const [cx, cy] = mercatorOf([center.lat, center.lng]);
    const up =
      (this.altitude(target) - map.getCenterElevation()) /
      ChaseCamera.metresPerPx(center.lat, world);
    const drawn = projectRelative(
      worldOffset(ax - cx) * world,
      (cy - ay) * world,
      up,
      map.getBearing(),
      map.getPitch(),
      distance,
    );
    const { width, height } = mapSize(map);
    // Where the marker is drawn: on the world copy nearest the centre
    const ground = map.project([center.lng + turnOf(center.lng, lon), lat]);
    return [width / 2 + drawn.x - ground.x, height / 2 + drawn.y - ground.y];
  }

  /**
   * Give the map back: clamped to the ground again, from a camera that
   * looks at the ground where this one looked through the air, so the view
   * does not jump as the map puts its centre back down. With the relief
   * the map eases the centre down by itself.
   */
  release(): void {
    const map = this.map;
    map.off("resize", this.onResize);
    this.panelWatch?.disconnect();
    const elevation = map.getCenterElevation();
    map.setCenterClampedToGround(true);
    // A map without its WebGL context is not moved: the listeners of the
    // move would ask it what it cannot answer (see hasLostContext)
    if (hasLostContext(map) || map.getTerrain() || !elevation) return;
    const center = map.getCenter();
    const { world, distance } = this.scale(map.getZoom());
    const metresPerPx = ChaseCamera.metresPerPx(center.lat, world);
    const b = map.getBearing() * RAD;
    const p = map.getPitch() * RAD;
    const [cx, cy] = mercatorOf([center.lat, center.lng]);
    // The camera, and the ground at sea level along its line of sight
    const back = (distance * Math.sin(p)) / world;
    const ahead = ((elevation / metresPerPx) * Math.tan(p)) / world;
    map.jumpTo(
      map.calculateCameraOptionsFromTo(
        new LngLat(
          ...lngLatOfMercator(cx - back * Math.sin(b), cy + back * Math.cos(b)),
        ),
        elevation + distance * metresPerPx * Math.cos(p),
        new LngLat(
          ...lngLatOfMercator(
            cx + ahead * Math.sin(b),
            cy - ahead * Math.cos(b),
          ),
        ),
        0,
      ),
    );
  }
}
