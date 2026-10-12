/**
 * Replay Camera - What follows the airplane of a replay: the pan and the
 * auto zoom that keep it in view, or the chase view (see chaseCamera.ts),
 * the user's hand on the map that they give way to, and the turn and the
 * lift of its icon as the map moves under it.
 */
import type { JumpToOptions, Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { ReplayAirplane, ReplayState } from "./replayState";
import { AUTO_ZOOM_MIN, MAX_FRAME_S } from "../utils/constants";
import {
  hasLostContext,
  isBehindGlobe,
  mapSize,
  REPLAY_CAMERA_MOVE,
  toLngLat,
  unwrapLng,
} from "../utils/mapHelpers";
import {
  airplaneLiftPx,
  heightAtZoomFt,
  type GroundedHeight,
} from "../calculations/airplaneLift";
import { liftExaggeration, ribbonWidthZoom } from "../calculations/lift";
import { prefersReducedMotion } from "../utils/motion";
import {
  DEGREES_TO_RADIANS,
  focalLengthPx,
  TILE_SIZE_PX,
  turnOf,
} from "../utils/geometry";
import { ChaseCamera, dampStep, type SavedCamera } from "./chaseCamera";

/** Minimum interval between map pans triggered by slider drags */
export const SEEK_PAN_THROTTLE_MS = 250;

/**
 * Time the frames the airplane spends near the edge count as one recenter
 * for auto zoom (ms)
 */
export const RECENTER_PAN_DURATION_MS = 500;

/**
 * About the time the camera takes to catch up with the airplane once it
 * follows it (s). The camera follows it as a critically damped spring: it
 * speeds up and slows down smoothly, and never overshoots.
 */
const FOLLOW_TIME_S = 0.6;

/** How long after its last frame a follow counts as over (ms), see follow */
const FOLLOW_STALE_MS = 1000;

/** Time the view takes back to where it was before a chase (ms) */
const CHASE_RESTORE_MS = 800;

/**
 * The longest the camera moves the map on without a rest (ms): what the app
 * does once the map comes to rest (see REPLAY_CAMERA_MOVE) runs this often
 * during a chase that never stops, so the airports ahead show as they come
 * near
 */
const CAMERA_REST_MS = 1000;

/**
 * One frame of the camera following the airplane: `offset` is where the
 * airplane is from the middle of the map, `velocity` the camera's speed
 * from the frame before, both in pixels (per second), and `dt` the time of
 * the frame. Returns how far the camera moves, and its speed now (see
 * dampStep).
 */
export function followStep(
  offset: { x: number; y: number },
  velocity: { x: number; y: number },
  dt: number,
): { move: { x: number; y: number }; velocity: { x: number; y: number } } {
  const [mx, vx] = dampStep(offset.x, velocity.x, dt, FOLLOW_TIME_S);
  const [my, vy] = dampStep(offset.y, velocity.y, dt, FOLLOW_TIME_S);
  return { move: { x: mx, y: my }, velocity: { x: vx, y: vy } };
}

/** Most levels one auto zoom-out takes; beyond that the jump disorients */
const AUTO_ZOOM_MAX_STEP = 4;

/** Duration of one auto zoom-out (ms) */
export const AUTO_ZOOM_DURATION_MS = 250;

/**
 * Time before auto-zoom may zoom out again (ms): the zoom-out above has to
 * end first, or the next one is measured on a map that is still moving.
 */
export const AUTO_ZOOM_SETTLE_MS = 300;

/**
 * The steepest the camera looks down past the point straight below it
 * (degrees short of that point) to find the ground a jump measures from
 * (see liftRoomPx)
 */
const NADIR_MARGIN_DEG = 5;

/**
 * How far above the middle of a map `height` pixels high, tilted by
 * `pitch` with a vertical field of view of `fov` (degrees), a lifted point
 * can be brought by a jump over the ground (see jumpToAirplane): as far as
 * the camera then stands short of the point straight above the ground
 * under it. An airplane lifted higher than that is above the camera, and
 * drawn above the middle by as much as it is.
 */
export function liftRoomPx(pitch: number, fov: number, height: number): number {
  // The camera's distance from the screen, in pixels
  const focal = focalLengthPx(height, fov * DEGREES_TO_RADIANS);
  // How far below the line of sight to the middle the ground may be seen
  const down = pitch - NADIR_MARGIN_DEG;
  return down > 0 ? focal * Math.tan(down * DEGREES_TO_RADIANS) : 0;
}

/** Fraction of the viewport used as the "near edge" margin for auto-panning */
const EDGE_MARGIN_FRACTION = 0.1;

/**
 * The camera lets go of the airplane once it is this many pixels from the
 * middle of the map, and moves slower than this many pixels per second
 */
const SETTLED_PX = 1;

/**
 * The rotation that shows `target` degrees after `previous`, turning the
 * short way. A CSS transition tweens the icon's raw angle, so writing the
 * heading as is spun the airplane almost a full turn whenever it crossed
 * north (350 to 10 degrees went back through 180).
 */
export function unwrapRotation(
  previous: number | null,
  target: number,
): number {
  if (previous === null) return target;
  return previous + turnOf(previous, target);
}

/** Pixels between the two points a heading on screen is measured from */
const HEADING_PROBE_PX = 16;

/**
 * The angle the airplane is drawn at inside its marker, clockwise from the
 * marker's top, for a track over the ground. The marker lies on the map
 * (see AirplaneMarker): MapLibre tilts it back with the map, so the icon
 * is foreshortened like the ground under it, and the angle it needs is the
 * one on the ground, seen from straight above.
 *
 * On a flat map that is north up the two are the same. Turned, the map's
 * bearing comes off; and on a globe north is not up anywhere but on the
 * centre meridian. Measuring between the position and a point a few pixels
 * further along the track answers for both at once. On a tilted map that
 * measures the track foreshortened, as it runs on screen: the part up the
 * screen is stretched back by the tilt, or the marker's own tilt would
 * foreshorten it a second time. An `upright` marker (the chase view's)
 * stands in the screen and takes the angle the track is drawn at.
 */
export function iconHeading(
  map: MapLibreMap,
  position: readonly [lat: number, lon: number],
  track: number,
  upright = false,
): number {
  if (upright) {
    // The chase keeps the airplane in the middle of a view along its track,
    // where a direction in the air is drawn as the tilt foreshortens it.
    // Measured on the ground it turned nose down over a slope that falls
    // away faster than the view looks down it.
    const turn = (track - map.getBearing()) * DEGREES_TO_RADIANS;
    return (
      Math.atan2(
        Math.sin(turn),
        Math.cos(turn) * Math.cos(map.getPitch() * DEGREES_TO_RADIANS),
      ) / DEGREES_TO_RADIANS
    );
  }
  const globe = map.getProjection()?.type === "globe";
  if (!globe && map.getBearing() === 0 && map.getPitch() === 0) return track;

  const [lat, lon] = position;
  // Degrees of latitude the probe spans at this zoom
  const step = (HEADING_PROBE_PX * 360) / (TILE_SIZE_PX * 2 ** map.getZoom());
  const radians = track * DEGREES_TO_RADIANS;
  // A degree of longitude shrinks with the latitude; held off the poles
  const shrink = Math.max(Math.cos(lat * DEGREES_TO_RADIANS), 0.01);
  const from = map.project([lon, lat]);
  const to = map.project([
    lon + (step * Math.sin(radians)) / shrink,
    Math.max(-89, Math.min(89, lat + step * Math.cos(radians))),
  ]);
  const dx = to.x - from.x;
  const dy = (to.y - from.y) / Math.cos(map.getPitch() * DEGREES_TO_RADIANS);
  if (dx === 0 && dy === 0) return track - map.getBearing();
  // Screen y grows downwards
  return Math.atan2(dx, -dy) / DEGREES_TO_RADIANS;
}

/** Where the airplane is on the screen, see airplaneOnScreen */
interface AirplaneOnScreen {
  mapSize: { x: number; y: number };
  /** Where the ground under the airplane is */
  ground: { x: number; y: number };
  /** Where the airplane is drawn */
  point: { x: number; y: number };
  behind: boolean;
  nearEdge: boolean;
  outside: boolean;
}

/**
 * Count a recenter of the map at `now`, and whether it is a new one: the
 * frames of a pan are one recenter, until the pan had its time to move the
 * map. Counted per frame, three frames in a row fired a burst of zoom-outs.
 */
function countRecenter(state: ReplayState, now: number): boolean {
  if (now < state.recenterPanEndsAt) return false;
  state.recenterPanEndsAt = now + RECENTER_PAN_DURATION_MS;
  const cutoffTime = now - 30000;
  state.recenterTimestamps = state.recenterTimestamps.filter(
    (ts) => ts > cutoffTime,
  );
  state.recenterTimestamps.push(now);
  return true;
}

/**
 * Levels to zoom out by once the airplane has left the map. It left because
 * it outruns the pan at this zoom, and how far outside it got says by how
 * much: each level out halves its speed on screen.
 */
export function zoomOutSteps(
  point: { x: number; y: number },
  size: { x: number; y: number },
): number {
  const halfX = size.x / 2;
  const halfY = size.y / 2;
  const ratio = Math.max(
    Math.abs(point.x - halfX) / halfX,
    Math.abs(point.y - halfY) / halfY,
  );
  if (!(ratio > 1)) return 1;
  return Math.min(AUTO_ZOOM_MAX_STEP, Math.ceil(Math.log2(ratio)));
}

/**
 * Whether the user moves the map right now, told from the map's own events.
 *
 * The gesture handlers cannot be asked: `isActive()` of a drag or a pinch
 * only turns true past the click tolerance, and nothing answers for an
 * arrow key or the glide after a drag. Every movement the user causes
 * starts with a `movestart` that carries the DOM event behind it, the
 * glide and the keys included, and the app's own camera moves carry none.
 * The press itself is followed as well, for the time before the first move.
 */
class UserMapMovement {
  private pressed = false;
  private moving = false;
  /** A turn or a tilt is under way, the compass's included */
  private turning = false;
  /** Removes the DOM listeners */
  private readonly listening = new AbortController();

  /**
   * A start that carries a DOM event is the user's. One that carries none
   * is a camera move of the app, and every camera move of MapLibre resets
   * the gesture handlers first: whatever the user was doing has ended with
   * it. That is the only word of it for a drag or a pinch, which MapLibre
   * ends without a `moveend` when it is cut short this way.
   */
  private readonly onMoveStart = (e: { originalEvent?: unknown }): void => {
    this.moving = e.originalEvent !== undefined;
  };

  /**
   * Only the end of a movement of the user ends it: a gesture let go, a
   * key's pan or a glide that ran out, each with the DOM event behind it.
   * The `moveend` of a camera move of the app carries none and says nothing
   * about the user.
   */
  private readonly onMoveEnd = (e: { originalEvent?: unknown }): void => {
    if (e.originalEvent) this.moving = false;
    this.turning = false;
  };

  /**
   * The compass turns the map with a camera move of the app, which carries
   * no DOM event. A follow pan would end it in its first frame all the same,
   * and the click would seem to do nothing. No follow pan turns or tilts, so
   * whatever does is left to finish.
   */
  private readonly onTurnStart = (): void => {
    this.turning = true;
  };

  constructor(private readonly map: MapLibreMap) {
    const container = map.getCanvasContainer();
    const signal = this.listening.signal;
    const press = (e: Event): void => {
      // The primary button only. The right one turns the map, which the
      // `movestart` of the turn says, and the context menu of a right
      // click swallows the `mouseup` on Linux and macOS, which would leave
      // the press on for good.
      if (e instanceof MouseEvent && e.button !== 0) return;
      this.pressed = true;
    };
    const release = (e: Event): void => {
      // One finger of a pinch that lifts leaves the other on the map
      // (asked by property: desktop browsers may not define TouchEvent)
      if ("touches" in e && (e as TouchEvent).touches.length > 0) return;
      this.pressed = false;
    };
    container.addEventListener("mousedown", press, { signal });
    container.addEventListener("touchstart", press, { signal, passive: true });
    // A button let go beside the map is still let go. A `contextmenu` is no
    // release: a long press on Android fires it with the finger still down.
    for (const type of ["mouseup", "touchend", "touchcancel", "blur"]) {
      window.addEventListener(type, release, { signal });
    }
    // A `mouseup` that went missing (a menu that opened over the press)
    // shows in the next move of the mouse, which knows its buttons
    window.addEventListener(
      "mousemove",
      (e) => {
        if (this.pressed && e.buttons === 0) this.pressed = false;
      },
      { signal, passive: true },
    );
    map.on("movestart", this.onMoveStart);
    map.on("zoomstart", this.onMoveStart);
    map.on("rotatestart", this.onTurnStart);
    map.on("pitchstart", this.onTurnStart);
    map.on("moveend", this.onMoveEnd);
  }

  isActive(): boolean {
    // Should an end ever go missing, a map at rest is proof enough
    if (!this.map.isMoving()) this.moving = this.turning = false;
    // The wheel has neither a press nor, before the frame that follows its
    // first event, a move; its handler is active from that event on
    return (
      this.pressed ||
      this.moving ||
      this.turning ||
      this.map.scrollZoom.isActive()
    );
  }

  stop(): void {
    this.listening.abort();
    this.map.off("movestart", this.onMoveStart);
    this.map.off("zoomstart", this.onMoveStart);
    this.map.off("rotatestart", this.onTurnStart);
    this.map.off("pitchstart", this.onTurnStart);
    this.map.off("moveend", this.onMoveEnd);
  }
}

/**
 * Where the airplane is and where it heads, for the turns and the lift
 * that follow the map. `heightFt` is its height above the flight's
 * ground, null while the trail is flat, with the ground of the relief
 * levels around there (see ReplayState.airplaneHeight).
 */
interface AirplaneHeading extends GroundedHeight {
  marker: ReplayAirplane;
  /** Where the airplane is on its flight's curve (see replayPoint) */
  position: [number, number];
  track: number;
  /** The relief's exaggeration of the height (see ChaseTarget) */
  exaggeration: number;
  /** The replay's, whose trail's ribbons are as wide as the zoom asks */
  state: ReplayState;
}

export class ReplayCamera {
  /** The marker element whose rotating icon is cached, and that icon */
  private iconRoot: HTMLElement | null = null;
  private iconDiv: HTMLElement | null = null;
  private lastTransform = "";
  /** Unwrapped rotation of the icon in degrees (see unwrapRotation) */
  private rotation: number | null = null;
  /** Wall-clock time before which auto-zoom does not zoom out again */
  private autoZoomSettlesAt = 0;
  /** Follows the user's hand on the map while a replay follows the airplane */
  private userMovement: UserMapMovement | null = null;
  /** The airplane, where it is and the track it flies, as last displayed */
  private heading: AirplaneHeading | null = null;
  /** The map whose moves turn the icon, while a replay shows one */
  private turningWith: MapLibreMap | null = null;
  /**
   * While the camera follows the airplane: its speed in pixels per second,
   * where the airplane was left on the screen, and the wall-clock time and
   * the zoom of the frame before. Null while it leaves the map alone.
   */
  private following: {
    velocity: { x: number; y: number };
    left: { x: number; y: number };
    at: number;
    zoom: number;
  } | null = null;
  /** The chase view while it has the camera (see chaseAirplane) */
  private chase: ChaseCamera | null = null;
  /**
   * The camera an ended chase eases back to, and until when: a chase that
   * starts meanwhile gives that one back, not the view half way there
   */
  private restoring: { camera: SavedCamera; until: number } | null = null;
  /** Whether the user's hand held the chase on the frame before */
  private chaseHeld = false;
  /** The frame a paused chase settles in, while one is pending */
  private chaseFrame: number | null = null;
  /**
   * Since when the camera has moved the map without a rest, and whether it
   * zoomed it; null while it has not moved it (see rest)
   */
  private unrested: { since: number; zoomed: boolean } | null = null;
  /** Whether it has moved the map in the frame the rest was looked for */
  private jumped = false;
  /** The frame the rest is looked for in, while one is pending */
  private restFrame: number | null = null;
  /** Whether the rest waits for the map to have its WebGL context back */
  private restAwaited = false;

  /** Whether the camera is moving the map for a frame of `follow` */
  private framing = false;

  /** Wall-clock time before which the follow leaves the map alone (hold) */
  private heldUntil = 0;

  /**
   * Leave the map to a move of the replay's own for `ms`: the follow would
   * jump to an airplane that has gone on to the next of several flights,
   * off the map, and zoom out as it found it there
   */
  hold(ms: number): void {
    this.heldUntil = performance.now() + ms;
  }

  /**
   * Whether the user's hand is on the map: a camera move of the replay's
   * own would end their drag or pinch (see keepAirplaneInView)
   */
  userMoving(): boolean {
    return !!this.userMovement?.isActive();
  }

  /**
   * A map that turns under a paused airplane changes where its track
   * points on screen, and no frame of the replay comes to say so. The
   * moves of a frame's own camera do not count: the frame turns the icon
   * once they are done (see follow).
   */
  private readonly onMapMove = (): void => {
    if (!this.framing) this.turnIcon();
  };

  /**
   * @param onTrailStale - The trail's ribbons were cut for another zoom
   *   level and are to be written again
   */
  constructor(
    private readonly app: MapApp,
    private readonly onTrailStale: (state: ReplayState) => void,
  ) {}

  /**
   * The rotating icon inside the airplane marker. Every activation builds a
   * new marker, so the lookup is keyed on its element and only runs when
   * that changes, not once per frame.
   */
  private airplaneIcon(marker: ReplayAirplane): HTMLElement | null {
    const root = marker.getElement();
    if (root !== this.iconRoot) {
      this.iconRoot = root;
      const found = root?.querySelector(".replay-airplane-icon");
      this.iconDiv = found instanceof HTMLElement ? found : null;
      this.lastTransform = "";
      this.rotation = null;
    }
    return this.iconDiv;
  }

  /**
   * Put the airplane where it is and turn it to where it heads, once
   * `moveCamera` has moved the map for the frame. Each of its jumps fires
   * a `move`, which would otherwise turn the icon once more each time.
   */
  follow(heading: AirplaneHeading, moveCamera?: () => void): void {
    this.heading = heading;
    if (moveCamera) {
      this.framing = true;
      try {
        moveCamera();
      } finally {
        this.framing = false;
      }
    }
    this.turnIcon();
  }

  /**
   * Start following the user's hand on the map. Called as a replay opens
   * and not on the first frame that pans: a press that began before that
   * frame would never be seen.
   */
  watchUser(): void {
    const map = this.app.map;
    if (map) this.userMovement ??= new UserMapMovement(map);
  }

  /** Stop listening to the map and to the user's hand on it; the replay is closing */
  stopWatchingMap(): void {
    this.endChase();
    this.rest();
    this.userMovement?.stop();
    this.userMovement = null;
    this.turningWith?.off("move", this.onMapMove);
    this.turningWith = null;
    this.heading = null;
    this.following = null;
  }

  /**
   * Move the camera by one frame's jump, tagged so what the app does once
   * the map comes to rest skips it (see REPLAY_CAMERA_MOVE)
   */
  private jump(map: MapLibreMap, options: JumpToOptions): void {
    const zoom = map.getZoom();
    map.jumpTo(options, REPLAY_CAMERA_MOVE);
    this.moved(map, zoom);
  }

  /**
   * The camera has moved the map, from `zoom`: its rest is looked for in
   * the frames that follow, until one passes without a move, or every
   * CAMERA_REST_MS while the moves go on
   */
  private moved(map: MapLibreMap, zoom: number): void {
    this.unrested ??= { since: performance.now(), zoomed: false };
    this.unrested.zoomed ||= map.getZoom() !== zoom;
    this.jumped = true;
    this.restFrame ??= requestAnimationFrame(this.lookForRest);
  }

  private readonly lookForRest = (): void => {
    this.restFrame = null;
    const since = this.unrested?.since ?? -Infinity;
    const moving = this.jumped && performance.now() - since < CAMERA_REST_MS;
    this.jumped = false;
    // A gesture or an animation of the map ends in a `moveend` of its own;
    // a map without its WebGL context is waited for in rest
    const map = this.app.map;
    if (moving || (map && !hasLostContext(map) && map.isMoving())) {
      this.restFrame = requestAnimationFrame(this.lookForRest);
    } else this.rest();
  };

  /**
   * Tell the map's listeners the camera has come to rest: `zoomend` if it
   * zoomed and `moveend`, untagged, the events MapLibre fires at the end of
   * a move
   */
  private rest(): void {
    if (this.restFrame !== null) cancelAnimationFrame(this.restFrame);
    this.restFrame = null;
    this.jumped = false;
    const unrested = this.unrested;
    const map = this.app.map;
    // Nobody is told of a map the app has let go of
    if (!unrested || !map || this.app.signal.aborted) {
      this.unrested = null;
      return;
    }
    // A map without its WebGL context has its listeners told once its
    // style is back (see whenContextRestored), which throw asking it now.
    // A replay that closes meanwhile leaves it so as well.
    if (hasLostContext(map)) {
      if (this.restAwaited) return;
      this.restAwaited = true;
      map.once("webglcontextrestored", () => {
        map.once("style.load", () => {
          this.restAwaited = false;
          this.rest();
        });
      });
      return;
    }
    this.unrested = null;
    if (unrested.zoomed) map.fire("zoomend");
    map.fire("moveend");
  }

  /**
   * Turn the icon to the track (see iconHeading). Hardware-accelerated
   * transforms; the same angle as last time is not written again. The
   * marker is drawn nose up, so the rotation is the heading itself: the old
   * emoji pointed north-east and needed the difference taken out.
   */
  private turnIcon(): void {
    const map = this.app.map;
    if (!map || !this.heading) return;
    const { marker, track, state, position } = this.heading;
    const [lat, lon] = marker.getLatLng();
    if (lat !== position[0] || lon !== position[1]) marker.setLatLng(position);
    const chase = this.chase;
    // Chased, the airplane stands up in the screen at a size to read, and
    // is drawn where the camera sees it (see ChaseCamera.offsetOf)
    marker.setUpright(chase !== null);
    if (chase) {
      const [x, y] = chase.offsetOf(this.heading);
      marker.setLift(-y, x);
    } else {
      // Exaggerated as the trail is drawn, which keeps its level until a
      // zoom ends, over the relief the map draws under it at its zoom, as
      // the trail stands on it (see ribbonHeights)
      marker.setLift(
        airplaneLiftPx(
          map,
          map.getCenter().lat,
          heightAtZoomFt(this.heading, map.getZoom()),
          liftExaggeration(this.app.reliefLevel),
        ),
      );
    }
    // The ribbons are as wide as the zoom they were cut for (see lift.ts)
    if (
      state.trailWidthZoom !== null &&
      ribbonWidthZoom(map.getZoom()) !== state.trailWidthZoom
    ) {
      this.onTrailStale(state);
    }
    const iconDiv = this.airplaneIcon(marker);
    if (!iconDiv) return;
    if (this.turningWith !== map) {
      this.turningWith?.off("move", this.onMapMove);
      map.on("move", this.onMapMove);
      this.turningWith = map;
    }
    this.rotation = unwrapRotation(
      this.rotation,
      iconHeading(map, position, track, chase !== null),
    );
    const transform = "translate3d(0,0,0) rotate(" + this.rotation + "deg)";
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      iconDiv.style.transform = transform;
    }
  }

  /**
   * Chase the airplane while the replay's chase view is on (see
   * ChaseCamera), from behind and above, turning with it. Returns whether
   * the chase has the camera, so the follow pan keeps away from it. A
   * finished replay starts none, and reduced motion none at all: a camera
   * that turns with the airplane is what that setting asks to be spared.
   * The user's hand on the map holds it, as it does the follow pan, and it
   * picks up from where they left the map once they let go.
   */
  chaseAirplane(heading: AirplaneHeading, isManualSeek: boolean): boolean {
    const map = this.app.map;
    const state = heading.state;
    if (
      !map ||
      !state.chase ||
      prefersReducedMotion() ||
      (!this.chase && state.currentTime >= state.maxTime)
    ) {
      this.endChase();
      return false;
    }
    if (this.userMovement?.isActive()) {
      this.chaseHeld = true;
      return true;
    }
    if (!this.chase) {
      const restoring = this.restoring;
      this.restoring = null;
      this.chase = new ChaseCamera(
        map,
        () => this.chaseAgain(this.heading?.state.playing ?? true),
        restoring && performance.now() < restoring.until
          ? restoring.camera
          : undefined,
      );
    } else if (this.chaseHeld) this.chase.resume();
    this.chaseHeld = false;
    const zoom = map.getZoom();
    const settled = this.chase.step(
      heading,
      state.speed,
      performance.now(),
      isManualSeek,
    );
    this.moved(map, zoom);
    if (!settled) this.chaseAgain(state.playing);
    return true;
  }

  /** Move a paused chase on: no frame of a paused replay comes to do it */
  private chaseAgain(playing: boolean): void {
    if (playing || this.chaseFrame !== null) return;
    this.chaseFrame = requestAnimationFrame(() => {
      this.chaseFrame = null;
      const last = this.heading;
      if (!last || last.state.playing) return;
      // A map without its WebGL context is waited out, frame by frame
      const map = this.app.map;
      if (map && hasLostContext(map)) this.chaseAgain(false);
      else this.chaseAirplane(last, false);
    });
  }

  /**
   * Give the camera back from the chase, if it has it, and with `restore`
   * the view from before it: all of it as the replay closes (`"all"`), and
   * otherwise its zoom, turn and tilt over the airplane where it is now.
   * Returns the camera from before the chase, for a view of its own.
   */
  endChase(restore?: "all" | "view"): SavedCamera | null {
    const chase = this.chase;
    if (this.chaseFrame !== null) cancelAnimationFrame(this.chaseFrame);
    this.chaseFrame = null;
    this.chaseHeld = false;
    const map = this.app.map;
    if (!chase || !map) return null;
    this.chase = null;
    // At rest where the chase left the map, and not half way into the view
    // it eases back to, which ends in a `moveend` of its own
    this.rest();
    chase.release();
    const saved = chase.saved;
    const position = this.heading?.position;
    if (restore && !hasLostContext(map)) {
      const camera =
        restore === "view" && position
          ? { ...saved, center: { lng: position[1], lat: position[0] } }
          : saved;
      map.easeTo({
        ...camera,
        duration: CHASE_RESTORE_MS,
        animate: !prefersReducedMotion(),
      });
      this.restoring = {
        camera,
        until: performance.now() + CHASE_RESTORE_MS,
      };
    }
    this.turnIcon();
    return saved;
  }

  /** The camera from before the chase, while one has the map */
  chaseView(): SavedCamera | null {
    return this.chase?.saved ?? null;
  }

  /**
   * Follow the airplane once it approaches the viewport edge, until it is
   * back in the middle (see trackAirplane). During slider drags the map
   * jumps to it, throttled; auto zoom-out only happens while playing.
   */
  keepAirplaneInView(
    state: ReplayState,
    currentPos: [number, number],
    isManualSeek: boolean,
  ): void {
    const map = this.app.map;
    if (!map) return;

    // A zoom in flight, auto-zoom's own or the user's, is left to finish:
    // a camera move of MapLibre ends the one before it, and the pan would
    // freeze the zoom half way
    // The same goes for the user's hand on the map: a camera move resets
    // every gesture, so a pan on each frame would end a drag or a pinch the
    // moment it starts. The follow picks up again once the airplane nears
    // the edge after they let go, and so it does after the compass on its
    // way north, which is a move of the app.
    // And a move of the replay's own to the next of several flights (see
    // hold)
    if (
      map.isZooming() ||
      this.userMovement?.isActive() ||
      performance.now() < this.heldUntil
    ) {
      this.following = null;
      return;
    }

    // A follow from before a pause is over: the map may have been dragged
    // since, and the next frame read the drag as the airplane's speed. A
    // second, not a frame or two: below 5 frames a second (3D in software
    // WebGL) every frame would start from rest and the follow lose its
    // smoothing.
    const now = Date.now();
    if (this.following && now - this.following.at > FOLLOW_STALE_MS) {
      this.following = null;
    }
    const view = this.airplaneOnScreen(map, state, currentPos);
    if (!view.nearEdge && !this.following) return;

    if (isManualSeek) {
      this.following = null;
      if (view.nearEdge) this.jumpOnSeek(map, state, view, currentPos, now);
      return;
    }

    this.trackAirplane(
      map,
      state,
      view.point,
      view.ground,
      currentPos,
      view.mapSize,
      view.behind ? null : view.outside,
      now,
    );
    if (!view.nearEdge) return;

    const newRecenter = countRecenter(state, now);
    if (state.autoZoom) {
      this.autoZoomOut(map, state, currentPos, view, newRecenter, now);
    }
  }

  /** How far up the screen the airplane is drawn, over its ground */
  private liftPx(map: MapLibreMap, state: ReplayState): number {
    return airplaneLiftPx(
      map,
      map.getCenter().lat,
      heightAtZoomFt(state.airplaneHeight(), map.getZoom()),
      liftExaggeration(this.app.reliefLevel),
    );
  }

  /**
   * Where the airplane is on the screen: drawn in the 3D view up at its
   * height, where the camera has to keep it and not at the ground under
   * it; whether it is near the edge of the map, or off it
   */
  private airplaneOnScreen(
    map: MapLibreMap,
    state: ReplayState,
    currentPos: [number, number],
  ): AirplaneOnScreen {
    // Every frame, so not of the container, which lays the page out
    const { width, height } = mapSize(map);
    const size = { x: width, y: height };
    // In the copy of the world the map looks at: the curve of a flight
    // across the antimeridian goes on past 180, and the map's centre may
    // have wrapped back since (see ChaseCamera.offsetOf)
    const ground = map.project([
      unwrapLng(currentPos[1], map.getCenter().lng),
      currentPos[0],
    ]);
    const point = { x: ground.x, y: ground.y - this.liftPx(map, state) };
    const marginX = size.x * EDGE_MARGIN_FRACTION;
    const marginY = size.y * EDGE_MARGIN_FRACTION;

    // Behind the globe the airplane projects into the disc, never off the
    // map, while the marker is hidden: a long flight would fly over the rim
    // and leave an empty globe behind
    const behind = isBehindGlobe(map, {
      lat: currentPos[0],
      lng: currentPos[1],
    });
    const nearEdge =
      behind ||
      point.x < marginX ||
      point.x > size.x - marginX ||
      point.y < marginY ||
      point.y > size.y - marginY;
    const outside =
      behind ||
      point.x < 0 ||
      point.x > size.x ||
      point.y < 0 ||
      point.y > size.y;
    return { mapSize: size, ground, point, behind, nearEdge, outside };
  }

  /**
   * Bring the airplane to the middle of the map in one jump, or as near as
   * the tilt lets it (see liftRoomPx): first the ground under it to the
   * middle, then the camera over the ground by as much as brings that
   * ground its lift below the middle, which is the way from the ground
   * drawn there to the ground under the airplane. Measured the other way,
   * from the ground drawn at the lifted point, it came out wrong on a
   * tilted map, whose far side has more ground to a pixel than its near
   * one, and above its horizon no ground answers at all: a map zoomed in
   * on an airplane high up ran off hundreds of kilometres a second.
   */
  private jumpToAirplane(
    map: MapLibreMap,
    state: ReplayState,
    position: [lat: number, lon: number],
  ): void {
    this.jump(map, { center: toLngLat(position) });
    const lift = Math.min(
      this.liftPx(map, state),
      liftRoomPx(
        map.getPitch(),
        map.getVerticalFieldOfView(),
        mapSize(map).height,
      ),
    );
    if (!(lift > 0)) return;
    const ground = map.project(toLngLat(position));
    const below = map.unproject([ground.x, ground.y + lift]);
    const middle = map.getCenter();
    this.jump(map, {
      center: [
        middle.lng + unwrapLng(position[1], below.lng) - below.lng,
        middle.lat + position[0] - below.lat,
      ],
    });
  }

  /**
   * During a slider drag the map jumps to the airplane near the edge,
   * throttled, and at once for one that has left the map
   */
  private jumpOnSeek(
    map: MapLibreMap,
    state: ReplayState,
    view: AirplaneOnScreen,
    position: [lat: number, lon: number],
    now: number,
  ): void {
    const throttled = now - state.lastSeekPanTime < SEEK_PAN_THROTTLE_MS;
    if (throttled && !view.outside) return;
    state.lastSeekPanTime = now;
    this.jumpToAirplane(map, state, position);
  }

  /**
   * Zoom out when the map had to recenter frequently in a short time
   * (`newRecenter` counts one more), or right away once the airplane has
   * left the map: the pan cannot keep up at this zoom, and waiting for more
   * recenters kept it off screen for seconds at 200x
   */
  private autoZoomOut(
    map: MapLibreMap,
    state: ReplayState,
    currentPos: [number, number],
    view: AirplaneOnScreen,
    newRecenter: boolean,
    now: number,
  ): void {
    const fiveSecondsAgo = now - 5000;
    const frequent =
      newRecenter &&
      state.recenterTimestamps.filter((ts) => ts >= fiveSecondsAgo).length > 2;
    if (!frequent && !view.outside) return;
    if (now < this.autoZoomSettlesAt) return;

    // From the map's own zoom: a remembered level goes stale as soon as the
    // user zooms, and "zoom out" then zoomed in
    const zoom = map.getZoom();
    if (zoom <= AUTO_ZOOM_MIN) return;
    const steps = view.outside ? zoomOutSteps(view.point, view.mapSize) : 1;
    // Onto the airplane, not around the centre: no pan runs while the map
    // zooms (see keepAirplaneInView), and the old centre had lost the
    // airplane by then
    map.easeTo({
      // The short way, in the world the map looks at (see airplaneOnScreen)
      center: [unwrapLng(currentPos[1], map.getCenter().lng), currentPos[0]],
      zoom: Math.max(AUTO_ZOOM_MIN, zoom - steps),
      duration: AUTO_ZOOM_DURATION_MS,
      animate: !prefersReducedMotion(),
    });
    this.following = null;
    state.recenterTimestamps = [];
    this.autoZoomSettlesAt = now + AUTO_ZOOM_SETTLE_MS;
  }

  /**
   * Move the camera one frame after the airplane, which is at `point` on
   * the screen, by a jump rather than an animation: an animation asked for
   * on every frame starts from rest on every frame, and stuttered between
   * steps of a few metres and of a hundred at 100x. The camera follows as a
   * damped spring (see followStep) and keeps the airplane off the edge of
   * the map, whatever the speed; it lets go once the airplane is back in
   * the middle and at rest there. Without motion, with the airplane behind
   * a globe (`outside` null), or off the map (`outside`) further than a
   * spring could follow or before it followed, it jumps to the airplane
   * instead (see jumpToAirplane). `point` is where the airplane is drawn,
   * `ground` where the ground under it `position` is.
   */
  private trackAirplane(
    map: MapLibreMap,
    state: ReplayState,
    point: { x: number; y: number },
    ground: { x: number; y: number },
    position: [lat: number, lon: number],
    mapSize: { x: number; y: number },
    outside: boolean | null,
    now: number,
  ): void {
    const zoom = map.getZoom();
    // Pixels mean other metres at another zoom
    const before = this.following?.zoom === zoom ? this.following : null;
    // The middle of the map, on the screen
    const middle = map.project(map.getCenter());
    const offset = { x: point.x - middle.x, y: point.y - middle.y };
    // A frame that took long may have taken it off the edge; one that is
    // further off than the map is wide is lost to a spring
    const lost =
      Math.abs(offset.x) > mapSize.x || Math.abs(offset.y) > mapSize.y;
    if (
      outside === null ||
      (outside && (lost || !before)) ||
      prefersReducedMotion()
    ) {
      this.following = null;
      this.jumpToAirplane(map, state, position);
      return;
    }
    const velocity = before?.velocity ?? { x: 0, y: 0 };
    const dt = before
      ? Math.min(Math.max((now - before.at) / 1000, 1e-3), MAX_FRAME_S)
      : 1 / 60;
    // The spring aims as far ahead of the airplane as it flies in the time
    // the spring takes, and so keeps up with it at any speed rather than
    // trail it by that far
    const flying = before
      ? {
          x: (point.x - before.left.x) / dt,
          y: (point.y - before.left.y) / dt,
        }
      : { x: 0, y: 0 };
    const step = followStep(
      {
        x: offset.x + flying.x * FOLLOW_TIME_S,
        y: offset.y + flying.y * FOLLOW_TIME_S,
      },
      velocity,
      dt,
    );
    // However far behind the spring is, the airplane stays on the map: a
    // fast replay drags the camera along at its own speed. Half the margin
    // the follow starts at, so the spring has the room to pick up speed.
    const marginX = (mapSize.x * EDGE_MARGIN_FRACTION) / 2;
    const marginY = (mapSize.y * EDGE_MARGIN_FRACTION) / 2;
    const keep = (move: number, at: number, low: number, high: number) =>
      Math.min(Math.max(move, at - high), at - low);
    const move = {
      x: keep(step.move.x, point.x, marginX, mapSize.x - marginX),
      y: keep(step.move.y, point.y, marginY, mapSize.y - marginY),
    };
    const left = { x: point.x - move.x, y: point.y - move.y };
    const settled =
      Math.hypot(left.x - middle.x, left.y - middle.y) < SETTLED_PX &&
      Math.hypot(step.velocity.x, step.velocity.y) < SETTLED_PX &&
      Math.hypot(flying.x, flying.y) < SETTLED_PX;
    this.following = settled
      ? null
      : {
          // Held back by the margins, the camera went at the airplane's pace
          velocity:
            move.x === step.move.x && move.y === step.move.y
              ? step.velocity
              : { x: move.x / dt, y: move.y / dt },
          left,
          at: now,
          zoom,
        };
    // Moved over the ground by as much as it takes to bring the ground
    // under the airplane to where it is to be on the screen: a move of the
    // middle by the same pixels would not do on a tilted map, whose far
    // side has more ground to a pixel than its near one
    const target = map.unproject([ground.x - move.x, ground.y - move.y]);
    const middleNow = map.getCenter();
    this.jump(map, {
      center: [
        middleNow.lng + unwrapLng(position[1], target.lng) - target.lng,
        middleNow.lat + position[0] - target.lat,
      ],
    });
  }
}
