/**
 * Replay Renderer - Handles rendering concerns for flight replay
 */
import {
  Marker,
  Popup,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type PositionAnchor,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { ReplayAirplane, ReplayState, TrailTip } from "./replayState";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { frameCoalescer } from "../utils/frameCoalescer";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { formatNumber, formatTrack } from "../utils/formatters";
import { formatSpeed, formatTime } from "../utils/replayFormatters";
import {
  FEET_TO_METERS,
  MAP_SOURCES,
  NAUTICAL_MILES_TO_KM,
} from "../utils/constants";
import { icon } from "../utils/icons";
import {
  closeWhenBehindGlobe,
  createActivationFilter,
  fromLngLat,
  hasLostContext,
  panPopupIntoView,
  toLngLat,
} from "../utils/mapHelpers";
import { calculateBearing, turnOf } from "../utils/geometry";
import {
  isLiftedAt,
  liftExaggeration,
  ribbonWidthZoom,
} from "../calculations/lift";
import { legAt, replayPoint, type ReplayPoint } from "../features/replay";
import { datasetIndex } from "../calculations/datasetIndex";
import { flightRoute } from "./airportFlights";
import { prefersReducedMotion } from "../utils/motion";
import { ReplayCamera } from "./replayCamera";
import {
  appendTrailSegment,
  speedColouredTrail,
  truncateTrail,
  trailFeatureCollection,
} from "./replayTrail";

/** Pixels between the airplane's position and the tip of its popup */
const AIRPLANE_POPUP_OFFSET = 16;

/**
 * The popup's offset for each side it may open on, as MapLibre makes of
 * AIRPLANE_POPUP_OFFSET, with the whole of it moved up by `lift` pixels
 * and right by `across` to where the airplane is drawn
 */
function liftedPopupOffset(
  lift: number,
  across = 0,
): Record<PositionAnchor, [number, number]> {
  const o = AIRPLANE_POPUP_OFFSET;
  const corner = Math.round(Math.sqrt(0.5 * o * o));
  const sides: Record<PositionAnchor, [number, number]> = {
    center: [0, 0],
    top: [0, o],
    "top-left": [corner, corner],
    "top-right": [-corner, corner],
    bottom: [0, -o],
    "bottom-left": [corner, -corner],
    "bottom-right": [-corner, -corner],
    left: [o, 0],
    right: [-o, 0],
  };
  for (const offset of Object.values(sides)) {
    offset[0] += across;
    offset[1] -= lift;
  }
  return sides;
}

/** Shown in the readout while no segment has been reached */
const READOUT_PLACEHOLDER = "—";

/** Cells of the readout strip, in display order */
const READOUT_CELLS: [id: string, label: string][] = [
  ["replay-readout-altitude", "Altitude"],
  ["replay-readout-speed", "Groundspeed"],
  ["replay-readout-track", "Track"],
];

/** Metric counterpart of each readout cell; the track has no second unit */
const READOUT_ALT_CELLS: (string | null)[] = [
  "replay-readout-altitude-alt",
  "replay-readout-speed-alt",
  null,
];

/**
 * Find the index of the last segment whose time is at or before currentTime.
 * Returns -1 when no segment has started yet.
 */
export function findSegmentIndexAtTime(
  segments: PathSegment[],
  currentTime: number,
): number {
  let lo = 0;
  let hi = segments.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((segments[mid]?.time ?? 0) <= currentTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * Heading damping, in seconds of the flight: the airplane turns towards
 * the direction of its curve with this time constant. The direction turns
 * evenly along a piece of the curve but not across a point of it; this
 * takes the edge off that, and trails the curve by a degree or two in a
 * turn at the rate a light aircraft flies one.
 */
const HEADING_DAMPING_S = 0.4;

/**
 * The airplane: a marker whose element is a real button, and the popup that
 * a click on it, or Enter and Space while it has focus, opens and closes.
 * The browser turns those keys into a click on a button, so one listener
 * serves both.
 */
export class AirplaneMarker implements ReplayAirplane {
  readonly marker: Marker;
  readonly popup: Popup;
  /** Pixels the airplane is drawn above and right of its position */
  private lift = 0;
  private across = 0;
  private readonly map: MapLibreMap;
  private readonly element: HTMLButtonElement;

  /**
   * @param onActivate - Called for a click that finds the popup closed; the
   *   caller fills the popup with the current position and opens it
   */
  constructor(
    map: MapLibreMap,
    position: readonly [lat: number, lon: number],
    onActivate: () => void,
  ) {
    this.map = map;

    const element = document.createElement("button");
    element.type = "button";
    element.className = "replay-airplane-root";
    element.title = "Aircraft position";
    element.setAttribute("aria-label", "Aircraft position");
    element.setAttribute("aria-expanded", "false");
    // The rotation transition lives on the inner icon (see features.css);
    // MapLibre positions the root with transforms, which must not animate
    element.innerHTML =
      '<div class="replay-airplane-icon">' +
      icon("aircraftTop", 24, undefined, "solid") +
      "</div>";
    // MapLibre fires a map click for a click on a marker as well; the
    // app's handler tells it by its target and leaves the popup alone. The
    // second click of a double click or tap would close what the first
    // opened (see createActivationFilter).
    const isActivation = createActivationFilter();
    element.addEventListener("click", (event) => {
      if (!isActivation(event)) return;
      if (this.isPopupOpen()) this.closePopup();
      else onActivate();
    });
    this.element = element;

    // Opened by hand and not through setPopup, which toggles on the same
    // click a second time. A click on the map closes it through the app's
    // click handler, and the popup never takes focus from the marker.
    this.popup = new Popup({
      maxWidth: "none",
      closeOnClick: false,
      focusAfterOpen: false,
      offset: AIRPLANE_POPUP_OFFSET,
    });
    closeWhenBehindGlobe(map, this.popup);
    this.popup.on("open", () => element.setAttribute("aria-expanded", "true"));
    this.popup.on("close", () =>
      element.setAttribute("aria-expanded", "false"),
    );
    // Laid on the map: the icon is a view from above, and upright on a
    // tilted map it looked down on the aircraft while the ground under it
    // was seen at a slant. The heading is turned inside the marker, so its
    // own rotation stays with the viewport (see iconHeading).
    this.marker = new Marker({
      element,
      anchor: "center",
      pitchAlignment: "map",
      rotationAlignment: "viewport",
    })
      .setLngLat(toLngLat(position))
      .addTo(map);
  }

  getLatLng(): [lat: number, lon: number] {
    return fromLngLat(this.marker.getLngLat());
  }

  setLatLng(position: readonly [lat: number, lon: number]): void {
    const lngLat = toLngLat(position);
    this.marker.setLngLat(lngLat);
    // The popup is not bound to the marker, so it is taken along
    if (this.popup.isOpen()) this.popup.setLngLat(lngLat);
  }

  setLift(px: number, across = 0): void {
    if (px === this.lift && across === this.across) return;
    this.lift = px;
    this.across = across;
    this.marker.setOffset([across, -px]);
    if (this.popup.isOpen()) this.pointPopup();
  }

  /**
   * The popup points at the airplane where it is drawn, whichever side of
   * it the popup opens on: set while it is open, not on every frame of the
   * lift without it
   */
  private pointPopup(): void {
    this.popup.setOffset(liftedPopupOffset(this.lift, this.across));
  }

  setUpright(upright: boolean): void {
    // Laid on the map, a view from above goes flat as the map tilts: at
    // the chase view's tilt it was a sixth of its height. Asked on every
    // frame, and a marker lays itself out anew for every alignment it is
    // given, the same one included.
    const alignment = upright ? "viewport" : "map";
    if (this.marker.getPitchAlignment() !== alignment) {
      this.marker.setPitchAlignment(alignment);
    }
  }

  getElement(): HTMLButtonElement {
    return this.element;
  }

  setPopupContent(html: string): void {
    this.popup.setHTML(html);
  }

  openPopup(): void {
    if (this.popup.isOpen()) return;
    this.pointPopup();
    this.popup.setLngLat(this.marker.getLngLat()).addTo(this.map);
  }

  closePopup(): void {
    this.popup.remove();
  }

  isPopupOpen(): boolean {
    return this.popup.isOpen();
  }

  remove(): void {
    this.popup.remove();
    this.marker.remove();
  }
}

/** The last values written to the transport row, so a frame that changes
 * nothing visible writes nothing */
interface TransportCache {
  timeText: string;
  sliderValue: string;
}

export class ReplayRenderer {
  private app: MapApp;
  private transport: TransportCache = {
    timeText: "",
    sliderValue: "",
  };
  /** Segment index the airplane popup content was last built for */
  private popupIndex = -1;
  /** The frame the trail is written to the map in, while one is pending */
  private readonly trailFrame = frameCoalescer<ReplayState>((state) =>
    this.flushTrail(state),
  );
  /**
   * What follows the airplane: the camera, the turn of its icon and its
   * lift. A trail whose ribbons are cut for another zoom is written again.
   * The replay manager hands it the user's hand on the map and the chase
   * view (see ReplayCamera.watchUser and endChase).
   */
  readonly camera: ReplayCamera;
  /**
   * Told the replay's time on every display, a seek's and a frame's: the
   * flight profile's cursor follows it (ui/flightProfile.ts)
   */
  onTime: ((state: ReplayState) => void) | null = null;

  constructor(app: MapApp) {
    this.app = app;
    this.camera = new ReplayCamera(app, (state) => {
      state.trailDirty = true;
      this.scheduleTrailFlush(state);
    });
  }

  /** What the readout shows: the segment, and its track as written */
  private shownReadout: { segment: PathSegment | null; track: string } | null =
    null;

  /**
   * Create the readout strip inside the replay panel once. It reports the
   * values of the current position, so it must never be a live region: the
   * frame loop writes it many times a second.
   */
  ensureReadout(panel: HTMLElement): HTMLElement {
    const existing = panel.querySelector<HTMLElement>(".replay-readout");
    if (existing) return existing;

    const strip = document.createElement("div");
    strip.className = "replay-readout";
    strip.id = "replay-readout";
    this.shownReadout = null;

    READOUT_CELLS.forEach(([id, label], index) => {
      const cell = document.createElement("div");
      cell.className = "replay-readout-cell";

      const name = document.createElement("span");
      name.className = "replay-readout-label";
      name.textContent = label;

      const value = document.createElement("span");
      value.className = "replay-readout-value";
      value.id = id;
      value.textContent = READOUT_PLACEHOLDER;

      cell.append(name, value);

      const altId = READOUT_ALT_CELLS[index];
      if (altId) {
        const alt = document.createElement("span");
        alt.className = "replay-readout-alt";
        alt.id = altId;
        alt.textContent = "";
        cell.append(alt);
      }
      strip.append(cell);
    });

    const inner = panel.querySelector("#replay-controls-inner");
    (inner ?? panel).append(strip);
    return strip;
  }

  /**
   * Write the values of the current position. Only changed cells are
   * touched, so a paused replay does not keep dirtying the DOM, and nothing
   * is formatted while the segment and the track as written stay.
   */
  private updateReadout(segment: PathSegment | null, bearing: number): void {
    const track = segment ? formatTrack(bearing) : READOUT_PLACEHOLDER;
    const shown = this.shownReadout;
    if (shown?.segment === segment && shown.track === track) return;
    this.shownReadout = { segment, track };
    const feet = segment?.altitude_ft ?? 0;
    const knots = segment?.groundspeed_knots ?? 0;
    // Grouped digits, like the legends, the statistics panel and the segment
    // tooltip, rather than a fourth style
    const values: string[] = segment
      ? [formatNumber(feet) + " ft", formatSpeed(knots), track]
      : [READOUT_PLACEHOLDER, READOUT_PLACEHOLDER, READOUT_PLACEHOLDER];
    // Every other surface pairs both unit systems, so this one does too
    const alts: string[] = segment
      ? [
          formatNumber(feet * FEET_TO_METERS) + " m",
          formatNumber(knots * NAUTICAL_MILES_TO_KM) + " km/h",
        ]
      : ["", ""];

    READOUT_CELLS.forEach(([id], index) => {
      const cell = domCache.get(id);
      const text = values[index] ?? READOUT_PLACEHOLDER;
      if (cell && cell.textContent !== text) cell.textContent = text;

      const altId = READOUT_ALT_CELLS[index];
      if (!altId) return;
      const altCell = domCache.get(altId);
      const altText = alts[index] ?? "";
      if (altCell && altCell.textContent !== altText) {
        altCell.textContent = altText;
      }
    });
  }

  /**
   * Fill the airplane popup with the data of the segment at the current
   * replay time, and open it. Pass the already known segment index to avoid
   * a second lookup when called from the frame loop.
   */
  updateAirplanePopup(state: ReplayState, index?: number): void {
    if (!state.airplaneMarker || !this.app.replayActive) return;

    const segments = state.segments;
    if (segments.length === 0) return;

    const idx = index ?? findSegmentIndexAtTime(segments, state.currentTime);
    const currentSegment = segments[idx] ?? segments[0];
    if (!currentSegment) return;
    this.popupIndex = idx;

    // The marker is where the aircraft is now, part way along the segment;
    // the segment's own end point is where it will be
    const airplane = state.airplaneMarker;
    const position = airplane.getLatLng();
    const popupContent = generateSegmentPopupHtml({
      segment: currentSegment,
      position,
      altRange: state.colorAltRange,
      speedRange: state.colorSpeedRange,
      title: "Current position",
      icon: "aircraftTop",
    });

    // Filled before it opens, so it opens at its final size
    airplane.setPopupContent(popupContent);
    if (!airplane.isPopupOpen()) airplane.openPopup();

    // The popup pans the map only while the replay is paused. While playing
    // the pan would stop the one that follows the airplane each time, and
    // the map never caught up with it. Without it when paused, though, a
    // click on an airplane near the top edge opened the popup off the map.
    const map = this.app.map;
    if (map && !state.playing) {
      panPopupIntoView(map, airplane.popup, undefined, !prefersReducedMotion());
    }
  }

  /**
   * Hand the trail to the map in the next frame, if it changed. A drag of
   * the slider reports many positions per frame and every `setData` sends
   * the whole trail to the worker, so the writes are collected: one per
   * frame at most, and none for a frame that drew nothing new.
   */
  scheduleTrailFlush(state: ReplayState): void {
    if (state.trailDirty) this.trailFrame.schedule(state);
  }

  private flushTrail(state: ReplayState): void {
    // Written once the map has its style back (see ReplayManager)
    if (this.app.map && hasLostContext(this.app.map)) return;
    if (!state.trailDirty) return;
    state.trailDirty = false;
    // A replay that has ended meanwhile has emptied the source itself
    if (!state.layerActive) return;
    // The whole trail on every write, which measured cheap enough to keep:
    // the longest flight of the sample data (2800 segments) replayed at 500x
    // in Chrome grew from 90 runs and 1000 vertices a third of the way in to
    // 250 runs and 3000 vertices (87 KB) at the end, and the write went from
    // 0.5 to 0.9 ms of main thread, with no dropped frames. Sending only
    // the changed runs through `updateData` measured worse on the same
    // replay: more main thread per frame, and dropped frames.
    const map = this.app.map;
    if (!map) return;
    const widthZoom = ribbonWidthZoom(map.getZoom());
    state.trailWidthZoom = state.lifted ? widthZoom : null;
    const id =
      state.lifted && isLiftedAt(widthZoom)
        ? MAP_SOURCES.replayTrailRibbons
        : MAP_SOURCES.replayTrail;
    // Lifted or flat, the trail is in one source, and leaves the other
    if (state.trailWrittenTo !== null && state.trailWrittenTo !== id) {
      void map
        .getSource<GeoJSONSource>(state.trailWrittenTo)
        ?.setData({ type: "FeatureCollection", features: [] });
    }
    state.trailWrittenTo = id;
    void map
      .getSource<GeoJSONSource>(id)
      ?.setData(
        trailFeatureCollection(
          state,
          widthZoom,
          this.app.reliefLevel,
          this.app.relief.epoch,
        ),
      );
  }

  /** Drop a write that is still pending; the replay layer is going away */
  cancelTrailFlush(): void {
    this.trailFrame.cancel();
  }

  /**
   * Show the replay at its current time: the transport row, the trail up
   * to it, and the airplane where it is, turned along its track, with the
   * camera after it
   */
  updateDisplay(state: ReplayState, isManualSeek: boolean = false): void {
    this.updateTransport(state);
    this.onTime?.(state);
    // Nothing of the map moves while it has lost its WebGL context, and
    // every frame threw asking it: the frames after the restore catch up,
    // the trail from the last segment it has drawn
    if (this.app.map && hasLostContext(this.app.map)) return;

    // Find current position in replay timeline (for airplane positioning)
    const segments = state.segments;
    const currentIndex = findSegmentIndexAtTime(segments, state.currentTime);
    state.currentIndex = currentIndex;
    const lastSegment =
      currentIndex >= 0 ? (segments[currentIndex] ?? null) : null;

    this.drawNewSegments(state);

    // Update airplane marker position and rotation
    const marker = state.airplaneMarker;
    if (!marker || !this.app.map) return;

    if (!lastSegment) {
      const startCoords = segments[0]?.coords[0];
      if (startCoords) marker.setLatLng([startCoords[0], startCoords[1]]);
      this.updateReadout(null, 0);
      return;
    }

    const { position, onCurve } = this.placeAirplane(state, currentIndex);
    const bearing = this.dampedBearing(
      state,
      lastSegment,
      onCurve,
      isManualSeek,
    );
    this.updateReadout(lastSegment, bearing);
    // Placed by the camera as it turns the icon, after it has moved (see
    // ReplayCamera.follow)
    this.followAirplane(state, marker, position, bearing, isManualSeek);

    // While it plays, the trail is written in the frame the airplane moved
    // in, not a frame behind it: one frame at 100x is a hundred metres. Not
    // for a drag of the slider, whose events come faster than frames: the
    // frame writes it once.
    if (state.playing && state.trailDirty && !isManualSeek) {
      this.trailFrame.cancel();
      this.flushTrail(state);
    }

    // The popup describes a segment, so an open one is rebuilt only once the
    // airplane has reached another segment, not on every frame
    if (marker.isPopupOpen() && currentIndex !== this.popupIndex) {
      this.updateAirplanePopup(state, currentIndex);
    }
  }

  /**
   * "2 of 3, EDDS → EDTF": the flight `leg` of several the replay plays,
   * named by its route
   */
  legName(state: ReplayState, leg: number): string {
    const legs = state.smoothed?.legs ?? [];
    const segment = state.segments[legs[leg]?.first ?? -1];
    const data = this.app.currentData;
    const path =
      segment && data && datasetIndex(data).pathInfoById.get(segment.path_id);
    return `${leg + 1} of ${legs.length}${path ? ", " + flightRoute(path) : ""}`;
  }

  /**
   * The clock of a replay of several flights: which of them flies, and the
   * time into it ("2 of 3, EDDS → EDTF: 0:42 in"), still the one that
   * landed during the pause after it; never a date or an hour. Null for
   * one flight, whose clock is the replay's. The time is written as the
   * longest of them would be, so it keeps its width from one to the next
   * (see ReplayManager.setupReplayUI).
   */
  legClock(state: ReplayState, leg?: number): string | null {
    const legs = state.smoothed?.legs ?? [];
    if (legs.length < 2) return null;
    leg ??= legAt(legs, state.currentTime);
    const { start, finish } = legs[leg]!;
    // None before it starts, as its width is measured at another (see
    // ReplayManager.setupReplayUI)
    const into = Math.max(Math.min(state.currentTime, finish) - start, 0);
    const longest = Math.max(...legs.map((l) => l.finish - l.start));
    return `${this.legName(state, leg)}: ${formatTime(into, longest)} in`;
  }

  /** Write the time and the slider of the transport row */
  updateTransport(state: ReplayState): void {
    const currentTime = state.currentTime;
    // In the format of the total, so "0:03:26 / 3:22:57" rather than a
    // minute count beside an hour count
    const currentLabel = formatTime(currentTime, state.maxTime);
    const maxLabel = formatTime(state.maxTime);
    const legClock = this.legClock(state);

    // The transport row is written only when its text changes: at 50x the
    // label changes a few times a second, the frame loop runs sixty
    const timeText = legClock ?? currentLabel + " / " + maxLabel;
    if (timeText !== this.transport.timeText) {
      this.transport.timeText = timeText;
      const timeDisplay = domCache.get("replay-time-display");
      if (timeDisplay) {
        timeDisplay.textContent = timeText;
        // In full where too narrow a panel cuts it short (features.css)
        timeDisplay.title = legClock ?? "";
      }
    }

    const slider = domCache.get("replay-slider", HTMLInputElement);
    if (!slider) return;
    const sliderValue = currentTime.toString();
    if (sliderValue !== this.transport.sliderValue) {
      this.transport.sliderValue = sliderValue;
      slider.value = sliderValue;
    }
    // Rewriting this every frame would make screen readers announce
    // continuously, so only do it when the spoken value changes
    const valueText = legClock ?? currentLabel + " of " + maxLabel;
    if (slider.getAttribute("aria-valuetext") !== valueText) {
      slider.setAttribute("aria-valuetext", valueText);
    }
  }

  /**
   * Where the airplane is at the current time on the segment at `index`,
   * and on the flight's curve: its height there, and the trail up to it
   */
  private placeAirplane(
    state: ReplayState,
    index: number,
  ): { position: [number, number]; onCurve: ReplayPoint | null } {
    const segment = state.segments[index]!;
    const next = state.segments[index + 1];
    const currentTime = state.currentTime;
    // A segment's time is when it starts, so until the next segment's time
    // the airplane is on this one, moving from its first point to its
    // second. The last one of a flight takes the time the curve gives it
    // (see replayCurve), and the airplane waits at its end for the next.
    // The curve's time of each segment is that (ReplayCurve.spent).
    const [[lat1, lon1], [lat2, lon2]] = segment.coords;
    let fraction = 1;
    const start = segment.time ?? 0;
    const duration =
      state.smoothed?.spent[index] ??
      (next ? (next.time ?? 0) : state.maxTime) - start;
    if (duration > 0) {
      fraction = Math.min(Math.max((currentTime - start) / duration, 0), 1);
    }
    // On the flight's curve, where the lines and the trail run, as far
    // along it as the time says (see replayPoint); in the 3D view at its
    // height there. Known before the camera moves, which follows the
    // airplane up.
    const onCurve = state.smoothed
      ? replayPoint(state.smoothed, index, fraction)
      : null;
    const position: [number, number] = onCurve?.position ?? [
      lat1 + (lat2 - lat1) * fraction,
      lon1 + (lon2 - lon1) * fraction,
    ];
    state.airplaneHeightFt = state.lifted ? (onCurve?.heightFt ?? null) : null;
    state.airplaneOffsetsFt = onCurve?.offsetsFt;
    // Nothing is drawn at time 0 (see drawNewSegments)
    this.setTrailTip(
      state,
      onCurve && currentTime > 0 && state.layerActive
        ? {
            index,
            point: onCurve.point,
            position,
            heightFt: onCurve.heightFt,
            offsetsFt: onCurve.offsetsFt,
          }
        : null,
    );
    return { position, onCurve };
  }

  /**
   * The direction of the curve where the airplane is, damped lightly over
   * the time of the flight. A seek, a jump back or a stop takes it as it
   * is. A flight standing still keeps the heading it had.
   */
  private dampedBearing(
    state: ReplayState,
    segment: PathSegment,
    onCurve: ReplayPoint | null,
    isManualSeek: boolean,
  ): number {
    const [[lat1, lon1], [lat2, lon2]] = segment.coords;
    const track = onCurve
      ? onCurve.track
      : lat1 === lat2 && lon1 === lon2
        ? null
        : calculateBearing(lat1, lon1, lat2, lon2);
    const currentTime = state.currentTime;
    const last = state.lastBearing;
    const elapsed = currentTime - state.bearingTime;
    let bearing = last ?? track ?? 0;
    if (track !== null && (last === null || isManualSeek || elapsed < 0)) {
      bearing = track;
    } else if (track !== null && last !== null && elapsed > 0) {
      const turn = turnOf(last, track);
      bearing =
        (last + turn * (1 - Math.exp(-elapsed / HEADING_DAMPING_S)) + 360) %
        360;
    }
    state.lastBearing = bearing;
    state.bearingTime = currentTime;
    return bearing;
  }

  /**
   * Have the camera follow the airplane at `position`: in the chase view,
   * or keeping it in view while it plays or is sought; then turn and lift
   * its icon, after the camera, which may have moved the map under it
   */
  private followAirplane(
    state: ReplayState,
    marker: ReplayAirplane,
    position: [number, number],
    bearing: number,
    isManualSeek: boolean,
  ): void {
    const heading = {
      marker,
      position,
      track: bearing,
      ...state.airplaneHeight(),
      exaggeration: liftExaggeration(this.app.reliefLevel),
      state,
    };
    this.camera.follow(heading, () => {
      if (
        !this.camera.chaseAirplane(heading, isManualSeek) &&
        (state.playing || isManualSeek)
      ) {
        this.camera.keepAirplaneInView(state, position, isManualSeek);
      }
    });
  }

  /** Add the segments flown since the last frame to the trail */
  private drawNewSegments(state: ReplayState): void {
    if (!state.layerActive) return;

    // Nothing is drawn at time 0 (stopped/reset state)
    if (state.currentTime > 0) {
      const useAirspeedColors = speedColouredTrail(this.app);

      const segments = state.segments;
      for (let i = state.lastDrawnIndex + 1; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) continue;
        if ((seg.time ?? 0) > state.currentTime) break;
        appendTrailSegment(state, i, useAirspeedColors);
      }
    }
    // Written either way: whatever emptied or cut the trail before this
    // call is written too
    this.scheduleTrailFlush(state);
  }

  /**
   * Let the trail end at the airplane, and be written again once it has
   * moved on
   */
  private setTrailTip(state: ReplayState, tip: TrailTip | null): void {
    const was = state.trailTip;
    if (
      was?.index === tip?.index &&
      was?.position[0] === tip?.position[0] &&
      was?.position[1] === tip?.position[1]
    ) {
      return;
    }
    state.trailTip = tip;
    state.trailDirty = true;
    this.scheduleTrailFlush(state);
  }

  /** Take the segments flown after the given time off the trail */
  removeSegmentsAfter(state: ReplayState, time: number): void {
    truncateTrail(state, time);
    this.scheduleTrailFlush(state);
  }
}
