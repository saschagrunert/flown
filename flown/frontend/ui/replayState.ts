/**
 * Replay state data class - groups all replay-related properties.
 */
import type { Marker, Popup } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathSegment, PopupHost, TrailRun } from "../types";
import type { GroundedHeight } from "../calculations/airplaneLift";
import type { RibbonPiece } from "../calculations/ribbons";
import type { ReplayCurve } from "../features/replay";
import {
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  type Range,
} from "../state/store";

/**
 * Where the airplane is on the segment it flies, which the trail ends at:
 * the segment's index, the point of the flight's curve it has passed last,
 * and its `[lat, lon]` and height above the flight's ground, with the
 * ground of the levels around there (see replayPoint)
 */
export interface TrailTip {
  index: number;
  point: number;
  position: [lat: number, lon: number];
  heightFt: number;
  offsetsFt?: number[] | undefined;
}

/**
 * The airplane on the map. MapLibre's marker knows nothing of popups the way
 * the app uses them (`setPopup` toggles a second time on the same click), so
 * the marker and its popup are wrapped, like the airports are. Only the
 * shape lives here: this file is part of the main bundle, the airplane
 * itself comes with the feature bundle (see ReplayRenderer).
 */
export interface ReplayAirplane extends PopupHost {
  readonly marker: Marker;
  readonly popup: Popup;
  /** Latitude first, like the rest of the app */
  getLatLng(): [lat: number, lon: number];
  /** Move the airplane, and its popup with it while that is open */
  setLatLng(position: readonly [lat: number, lon: number]): void;
  /**
   * Draw the airplane, and its popup, `px` above its position and `across`
   * right of it: at its height in the 3D view (see airplaneLiftPx), which
   * the chase view places in perspective (see ChaseCamera.offsetOf)
   */
  setLift(px: number, across?: number): void;
  /**
   * Stand the airplane up in the screen, for the chase view, or lay it on
   * the map
   */
  setUpright(upright: boolean): void;
  /** The marker's element: a real button, so it takes focus and Enter */
  getElement(): HTMLButtonElement;
  setPopupContent(html: string): void;
  /** Take the marker and its popup off the map */
  remove(): void;
}

/** Whether a replay runs is the store's `replayActive` */
export class ReplayState {
  /** Whether the replay running is the one of every flight (ui/replayAll.ts) */
  all = false;
  /**
   * The tilt of a map the replay of every flight tilted to show the
   * heights, which it lays the map back to as it closes and which the link
   * and the saved state keep meanwhile; null where it tilted none, or the
   * user has taken the tilt over
   */
  pitchBefore: number | null = null;
  /**
   * The tilt the replay of every flight lays the map back to as it closes,
   * until the map gets there or another move ends the one there; null
   * otherwise (see restingPitch)
   */
  layingBack: number | null = null;
  playing = false;
  currentTime = 0;
  maxTime = 0;
  speed = 50.0;
  /** Whether the replay sources hold this replay's route and trail */
  layerActive = false;
  segments: PathSegment[] = [];
  airplaneMarker: ReplayAirplane | null = null;
  /** Index of the last segment drawn on the trail */
  lastDrawnIndex = -1;
  /** The trail flown so far as runs of one colour, in flight order */
  trailRuns: TrailRun[] = [];
  /** Set when the trail changed and the map has not been told yet */
  trailDirty = false;
  /** Index of the segment the airplane is currently on (-1 before start) */
  currentIndex = -1;
  /** The heading the airplane was last shown with, and the time of it */
  lastBearing: number | null = null;
  bearingTime = 0;
  animationFrameId: number | null = null;
  lastFrameTime: number | null = null;
  /**
   * The colour ranges of the trail: the flight's own, as the colour layers
   * draw a selection of it (see ReplayManager.calculateColorRanges)
   */
  colorAltRange: Range = DEFAULT_ALTITUDE_RANGE;
  colorSpeedRange: Range = DEFAULT_AIRSPEED_RANGE;
  /**
   * The ground under each segment of the flight, in feet (groundProfileFt):
   * sampled where the relief is drawn, the line between its fields elsewhere
   */
  groundFt: Float64Array = new Float64Array(0);
  /** Whether groundFt, and the heights of `smoothed`, are the sampled ones */
  onTerrain = false;
  /** The relief level the sampled groundFt was smoothed for (reliefLevel) */
  groundLevel = 0;
  /** Whether the trail and the airplane are lifted: the 3D view is on */
  lifted = false;
  /**
   * The flight along its curve, timed, at its height: where the airplane
   * flies and the trail runs, and what its ribbons are cut from in the 3D
   * view (see features/replay.ts); null without a replay
   */
  smoothed: ReplayCurve | null = null;
  /** Where the trail ends: at the airplane, null before it has started */
  trailTip: TrailTip | null = null;
  /**
   * The ribbon pieces of each run of the trail, as last cut up to the
   * segment `end` (exclusive): a run that has not grown since, at the same
   * width, is not cut again (see trailFeatureCollection)
   */
  trailPieces = new WeakMap<
    TrailRun,
    { end: number; widthZoom: number; pieces: RibbonPiece[] }
  >();
  /** The zoom the trail's ribbons were last written for, null for none */
  trailWidthZoom: number | null = null;
  /** The source the trail was last written to, its line's or its ribbons' */
  trailWrittenTo: string | null = null;
  /**
   * The airplane's height above the flight's ground where it is now, null
   * while it is not lifted; the camera follows it up there
   */
  airplaneHeightFt: number | null = null;
  /**
   * The ground of the relief levels around the one of groundFt where the
   * airplane is now, for its height over the relief of another level (see
   * airplaneHeight)
   */
  airplaneOffsetsFt: number[] | undefined = undefined;
  autoZoom = false;
  /** Whether the chase view is on (see ReplayCamera.chaseAirplane) */
  chase = false;
  recenterTimestamps: number[] = [];
  /** Wall-clock time before which pans count as the same recenter */
  recenterPanEndsAt = 0;
  /** Wall-clock time of the last pan triggered by a manual seek */
  lastSeekPanTime = 0;

  /** Where the airplane is lifted to (see airplaneHeightFt) */
  airplaneHeight(): GroundedHeight {
    return {
      heightFt: this.airplaneHeightFt,
      offsetsFt: this.airplaneOffsetsFt,
      level: this.groundLevel,
    };
  }

  resetDrawState(): void {
    this.currentTime = 0;
    // An emptied trail is a change the map has to hear of
    if (this.trailRuns.length > 0) this.trailDirty = true;
    this.lastDrawnIndex = -1;
    this.trailRuns = [];
    this.currentIndex = -1;
    this.trailTip = null;
    this.lastBearing = null;
    this.recenterTimestamps = [];
    this.recenterPanEndsAt = 0;
    this.lastSeekPanTime = 0;
  }
}

/**
 * The tilt of the map of `app` as the user left it: the one the replay of
 * every flight is laying it back to, while it does. What opens right after
 * that replay closes and keeps the user's view (Wrapped, the hotspot tour,
 * that replay once more) would keep a tilt from half way there.
 */
export function restingPitch(app: Pick<MapApp, "map" | "replayState">): number {
  return app.replayState.layingBack ?? app.map?.getPitch() ?? 0;
}
