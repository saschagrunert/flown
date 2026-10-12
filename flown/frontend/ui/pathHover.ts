/**
 * Path hover - the flight under the pointer, and its values
 *
 * Paths are pixels of a layer and have no events of their own. One
 * `mousemove` handler per map asks what is rendered under the pointer, at
 * most once per frame, and moves one reused tooltip along. MapApp's click
 * dispatcher asks the same (hitTest), and on touch, where nothing hovers, a
 * tap shows the values in a popup instead. The layer manager says which
 * layers to look in and which runs of segments their features stand for
 * (DrawnRuns); this module finds the segment nearest to the pointer among
 * them.
 */
import {
  Point as PointClass,
  Popup,
  type LngLat,
  type Map as MapLibreMap,
  type MapGeoJSONFeature,
  type MapMouseEvent,
  type Point,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type {
  PathHit,
  PathHitResult,
  PathRunProperties,
  PathSegment,
} from "../types";
import { isTouchDevice } from "../utils/device";
import { frameCoalescer } from "../utils/frameCoalescer";
import {
  closeWhenBehindGlobe,
  isInMarker,
  isOnMarker,
  toLngLat,
  unwrapLng,
  type LatLon,
  type LngLatTuple,
} from "../utils/mapHelpers";
import { flightCurves } from "../calculations/curves";
import { findNearestOnCurve, findNearestSegment } from "../features/layers";

/** The look the hover tooltip and the tapped popup share (styles.css) */
const SEGMENT_DETAILS_CLASS = "segment-details";

/**
 * How far from the pointer a flight still counts as under it, in pixels to
 * each side. A finger covers more of the map than it aims at.
 */
const HIT_PADDING_PX = 5;
const TOUCH_HIT_PADDING_PX = 12;

/** Distance of the tooltip from the pointer, in pixels */
const TOOLTIP_OFFSET_PX = 10;

/** A run of segments of one path, which a feature of a layer stands for */
export interface HoverRun {
  /** Half-open index range of the run within its segment array */
  start: number;
  end: number;
  pathId: number;
}

/** What the features of one layer stand for */
export interface RunsOnLayer {
  /**
   * The runs its features index by their `r`, and the generation `g` of
   * the features that do so still
   */
  table: { readonly runs: readonly HoverRun[]; readonly g: number };
  /** The segments the runs index into */
  segments: readonly PathSegment[];
  /** A selection's layer, which is on top: it wins a tie */
  selected: boolean;
  /**
   * Ribbons of the 3D view, drawn above their ground: how many pixels up
   * the screen the feature with `properties` is drawn (see liftOffsetPx);
   * null for lines
   */
  lift:
    | ((map: MapLibreMap, properties: Partial<PathRunProperties>) => number)
    | null;
  /**
   * The only paths the layer shows, null for every one: a selection in
   * share mode filters the others out, which tiles cut before the filter
   * still have
   */
  only: ReadonlySet<number> | null;
}

/**
 * A button under the values of a tapped segment (see showTapped). Its label
 * is asked again whenever the owner says the state it reads changed
 * (refreshTapped), null for no button: one that kept the label it opened
 * with offered "Select flight" for a flight ticked in a list since, and
 * took it out.
 */
export interface TapAction {
  label(): string | null;
  run(): void;
}

/** The layers to look in, by id */
export interface DrawnRuns {
  layers: ReadonlyMap<string, RunsOnLayer>;
  /**
   * Whether finding nothing may be wrong: a write to a source has not been
   * drawn yet, or the ribbons are out of sight as they settle
   */
  stale: boolean;
}

/** What the hover asks of the layer manager */
export interface HoverPaths {
  /** The map once the path sources exist on it, null before */
  readyMap(): MapLibreMap | null;
  /** The layers drawn now, see DrawnRuns */
  drawnRuns(map: MapLibreMap): DrawnRuns;
  /** The popup of a segment's values, coloured as its runs */
  describe(segment: PathSegment): string;
}

/** The parts of the app the hover reads */
type HoverApp = Pick<MapApp, "map" | "wrappedVisible" | "reliefLevel">;

/** A position of the data in the copy of the world nearest to `pointerLng` */
function nearPointer(latLon: LatLon, pointerLng: number): LngLatTuple {
  const [lng, lat] = toLngLat(latLon);
  return [unwrapLng(lng, pointerLng), lat];
}

/**
 * Distance in pixels between a point of the map and a drawn segment, or a
 * piece of its curve.
 *
 * `project` answers for the longitude it is given and does not wrap it, so
 * a segment lands in the copy of the world its data names, however far from
 * the pointer that is. Each end is projected into the copy nearest to
 * `pointerLng`, the pointer's longitude as the map reports it, unwrapped:
 * that is the one drawn under the pointer, which near the antimeridian need
 * not be the copy the pointer itself is in.
 */
function pixelDistance(
  map: MapLibreMap,
  point: Point,
  pointerLng: number,
  coords: readonly [LatLon, LatLon],
): number {
  const a = map.project(nearPointer(coords[0], pointerLng));
  const b = map.project(nearPointer(coords[1], pointerLng));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** A flight under the pointer, and how far from it in pixels */
interface Candidate {
  hit: PathHit;
  distance: number;
  selected: boolean;
}

export class PathHover {
  private readonly app: HoverApp;
  private readonly paths: HoverPaths;
  private destroyed = false;

  /** The map the pointer handlers are registered on */
  private listeningTo: MapLibreMap | null = null;
  /** The last move of the pointer over the map; null once it is off it */
  private lastMove: MapMouseEvent | null = null;
  private readonly hoverFrame = frameCoalescer<void>(() => this.hover());
  private rehoverPending = false;
  /** The one tooltip, created on the first hover and reused from then on */
  private tooltip: Popup | null = null;
  /** The segment the tooltip describes, null while it is closed */
  private hovered: PathSegment | null = null;
  /** The popup a tap opened; a tap elsewhere replaces it */
  private touchPopup: Popup | null = null;
  /** The flight of that popup, whose tooltip it stands in for */
  private tappedPathId: number | null = null;
  /** The button under its values and what it does, if it has one */
  private tapButton: { button: HTMLButtonElement; action: TapAction } | null =
    null;
  /**
   * Told the segment the tooltip comes to describe, and null as it closes:
   * the flight profile moves its cursor along (ui/flightProfile.ts)
   */
  onHover: ((segment: PathSegment | null) => void) | null = null;

  private readonly handleMouseMove = (e: MapMouseEvent): void => {
    // The overview of the Wrapped dialog is this map, but there to be
    // looked at: no frame is asked for that would find nothing to do
    if (this.app.wrappedVisible) {
      this.lastMove = null;
      return;
    }
    this.lastMove = e;
    // A pointer moves many times per frame, and a query walks the tiles.
    // What the pointer is on is asked in the frame as well, once.
    this.hoverFrame.schedule();
  };

  private readonly handleMouseOut = (): void => {
    this.lastMove = null;
    this.hideTooltip();
  };

  constructor(app: HoverApp, paths: HoverPaths) {
    this.app = app;
    this.paths = paths;
  }

  /** Follow the pointer over `map` */
  listen(map: MapLibreMap): void {
    this.listeningTo = map;
    map.on("mousemove", this.handleMouseMove);
    map.on("mouseout", this.handleMouseOut);
  }

  /** Stop following the pointer, and close what it opened */
  destroy(): void {
    this.destroyed = true;
    this.listeningTo?.off("mousemove", this.handleMouseMove);
    this.listeningTo?.off("mouseout", this.handleMouseOut);
    this.listeningTo = null;
    this.hoverFrame.cancel();
    this.lastMove = null;
    this.hideTooltip();
    this.closeTapped();
  }

  /**
   * The flight drawn at a point of the map, or null beside every flight.
   * Until a `setData` has landed the tiles still hold the data before it,
   * which may have flights where the new data has none, or none where the
   * new data has one: finding nothing then is "stale", neither a flight nor
   * the empty map, and a caller should leave things as they are.
   */
  hitTest(point: Point): PathHitResult {
    return this.look(point).result;
  }

  /**
   * Show the values of the segment a tap hit where the finger was, until
   * the next tap on the map closes them: a pointer that hovers has the
   * tooltip for that, and share mode holds them for a click as well (see
   * LayerManager.onPathClick). `action` is a button under the values, to
   * select the flight or take it out, which closes them. The hover's
   * tooltip of the same flight steps aside while they show: a mouse in
   * share mode had both, and the tooltip could cover the button.
   */
  showTapped(hit: PathHit, lngLat: LngLat, action?: TapAction): void {
    const map = this.app.map;
    if (!map) return;
    this.closeTapped();
    if (this.hovered?.path_id === hit.pathId) this.hideTooltip();
    const popup = (this.touchPopup = new Popup({
      // Not the tooltip's class: that one takes no pointer events, and
      // this popup has a close button to press
      className: `${SEGMENT_DETAILS_CLASS} segment-popup`,
      // MapLibre would close it on every click on the map, also on one
      // the click dispatcher decides to ignore (a "stale" hit), and the
      // values would go while nothing else happens. The dispatcher closes
      // it when the click is one on the empty map.
      closeOnClick: false,
      maxWidth: "none",
      focusAfterOpen: false,
    }));
    // Before it opens: that is the moment it starts to follow the map
    closeWhenBehindGlobe(map, popup);
    popup
      .setLngLat(lngLat)
      .setHTML(this.paths.describe(hit.segment))
      .addTo(map);
    this.tappedPathId = hit.pathId;
    // Closed by its own button as well, which MapLibre does by itself
    popup.on("close", () => {
      if (this.touchPopup !== popup) return;
      this.touchPopup = null;
      this.tappedPathId = null;
      this.tapButton = null;
    });
    if (!action) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment-action";
    button.onclick = () => {
      popup.remove();
      action.run();
    };
    popup.getElement()?.querySelector(".popup-container")?.append(button);
    this.tapButton = { button, action };
    this.refreshTapped();
  }

  /**
   * Label the button under the values of a tap anew, or hide it, for the
   * state it reads now (see TapAction)
   */
  refreshTapped(): void {
    if (!this.tapButton) return;
    const { button, action } = this.tapButton;
    const label = action.label();
    button.hidden = label === null;
    if (label !== null) button.textContent = label;
  }

  /** Put away the values a tap left on the map */
  closeTapped(): void {
    this.touchPopup?.remove();
    this.touchPopup = null;
    this.tappedPathId = null;
    this.tapButton = null;
  }

  /** Put away the values a hover or a tap left on the map */
  closeSegmentPopup(): void {
    this.hideTooltip();
    this.closeTapped();
  }

  /**
   * Look under the resting pointer again once the map has drawn what was
   * just changed. Until then the tiles answer with the features of before,
   * and the tooltip would close although the flight is still there.
   */
  rehoverOnIdle(): void {
    const map = this.app.map;
    if (!map || !this.lastMove || this.rehoverPending) return;
    this.rehoverPending = true;
    map.once("idle", () => {
      this.rehoverPending = false;
      if (this.destroyed) return;
      // The colour range may have changed under the same segment
      this.hovered = null;
      this.hover(true);
    });
  }

  /** `hitTest`, and whether the tiles had any feature at the point at all */
  private look(point: Point): { result: PathHitResult; found: boolean } {
    const map = this.paths.readyMap();
    if (!map) return { result: null, found: false };
    const { layers, stale } = this.paths.drawnRuns(map);
    if (layers.size === 0) return { result: null, found: false };
    const nothing: PathHitResult = stale ? "stale" : null;

    const pad = isTouchDevice() ? TOUCH_HIT_PADDING_PX : HIT_PADDING_PX;
    const features = map.queryRenderedFeatures(
      [
        [point.x - pad, point.y - pad],
        [point.x + pad, point.y + pad],
      ],
      { layers: [...layers.keys()] },
    );
    if (features.length === 0) return { result: nothing, found: false };

    // World copies are drawn, and a point in one of them is 360 degrees
    // away from the segments, which would all be equally far. Both the
    // search in degrees and the ranking in pixels take the pointer as the
    // map reports it, unwrapped, and put each segment into the copy of the
    // world nearest to it (see findNearestSegment and pixelDistance).
    const pointer = map.unproject(point);
    const seen = new Set<HoverRun>();
    let outdated = false;
    let best: Candidate | null = null;
    for (const feature of features) {
      const drawn = layers.get(feature.layer.id);
      if (!drawn) continue;
      const run = runOf(feature, drawn);
      if (run === "outdated") {
        outdated = true;
        continue;
      }
      // A run crossing a tile border comes back once per tile. Left out by
      // the filter of share mode, but still in tiles cut before it: a selected
      // path's main runs are not, they are the same flight, and they bridge
      // the moment until the selection's tiles are there.
      if (!run || seen.has(run) || drawn.only?.has(run.pathId) === false) {
        continue;
      }
      seen.add(run);
      const candidate = this.nearest(map, point, pointer, feature, drawn, run);
      if (candidate && isBetter(candidate, best)) best = candidate;
    }
    return {
      result: best?.hit ?? (outdated ? "stale" : nothing),
      found: true,
    };
  }

  /** The segment of `run` nearest to the pointer at `point`, if any */
  private nearest(
    map: MapLibreMap,
    point: Point,
    pointer: LngLat,
    feature: MapGeoJSONFeature,
    drawn: RunsOnLayer,
    run: HoverRun,
  ): Candidate | null {
    // A ribbon is drawn above the ground it stands on: the pointer is
    // taken down by as much before the segment and the distance to it
    // are looked for (see ribbonLiftPx in ui/pathRibbons.ts). Over the
    // relief that ground is raised too, but `project` and `unproject`
    // meet the relief themselves, of the level of the map's zoom, as the
    // ribbon's own height is taken.
    const properties = feature.properties as Partial<PathRunProperties>;
    const liftOf = properties.h === undefined ? undefined : drawn.lift;
    const ribbon = liftOf !== undefined;
    const lift = liftOf ? liftOf(map, properties) : 0;
    const ground = lift ? map.unproject([point.x, point.y + lift]) : pointer;
    // A line is drawn along its flight's curve, and its points belong to
    // the segment they lie on (see calculations/curves.ts); only the
    // flight under the pointer is smoothed for it
    const flight = ribbon ? null : flightCurves(drawn.segments, run.pathId);
    const onCurve =
      flight &&
      findNearestOnCurve(
        flight.curves,
        run.start - flight.from,
        run.end - flight.from,
        ground.lat,
        ground.lng,
      );
    const segment =
      flight && onCurve
        ? drawn.segments[onCurve.index + flight.from]
        : findNearestSegment(
            drawn.segments.slice(run.start, run.end),
            ground.lat,
            ground.lng,
          );
    if (!segment) return null;
    const distance = pixelDistance(
      map,
      new PointClass(point.x, point.y + lift),
      pointer.lng,
      onCurve?.piece ?? segment.coords,
    );
    return {
      hit: { pathId: run.pathId, segment },
      distance,
      selected: drawn.selected,
    };
  }

  /**
   * Where the pointer of the last move is, for a look: none over a marker,
   * which lies on top of the flights. The map reports `mouseout` as the
   * pointer comes onto one, and goes on reporting its moves there: over a
   * marker there is no flight to show, but the point is kept. A zoom may
   * take the marker from under a pointer that rests, or bring one there, so
   * after the map has moved the document is asked what is under the pointer
   * now rather than the event what it was aimed at.
   */
  private pointerPoint(mapHasMoved: boolean): Point | undefined {
    const move = this.lastMove;
    if (!move) return undefined;
    const onMarker = mapHasMoved
      ? isInMarker(
          document.elementFromPoint?.(
            move.originalEvent.clientX,
            move.originalEvent.clientY,
          ),
        )
      : isOnMarker(move);
    return onMarker ? undefined : move.point;
  }

  /** Look under the pointer and show, move on or close the tooltip */
  private hover(mapHasMoved = false): void {
    const map = this.app.map;
    const point = this.pointerPoint(mapHasMoved);
    // Not over the overview of the Wrapped dialog either (a pointer that
    // rested on the map as the dialog opened gets here through the look on
    // idle): MapApp ignores clicks on it as well
    const looks =
      !!map &&
      !!point &&
      !this.destroyed &&
      !isTouchDevice() &&
      !this.app.wrappedVisible;
    const { result: hit, found } = looks
      ? this.look(point)
      : { result: null, found: false };
    // A look on idle decides, with tiles that can tell. Asked for from
    // here: the one a redraw asks for is skipped while the pointer is off
    // the map. Until then the tooltip stays only where the tiles of before
    // have a flight, which may well still be there; over nothing at all
    // there is nothing to go on showing.
    if (hit === "stale") {
      this.rehoverOnIdle();
      if (found) return;
    }
    // Over the flight whose values a tap or a click holds open, the
    // tooltip would only cover them
    if (
      !map ||
      !point ||
      !hit ||
      hit === "stale" ||
      hit.pathId === this.tappedPathId
    ) {
      this.hideTooltip();
      return;
    }
    this.showTooltip(map, point, hit.segment);
  }

  /** Show the values of `segment` at the pointer, at `point` */
  private showTooltip(
    map: MapLibreMap,
    point: Point,
    segment: PathSegment,
  ): void {
    const tooltip = (this.tooltip ??= new Popup({
      closeButton: false,
      closeOnClick: false,
      focusAfterOpen: false,
      className: `${SEGMENT_DETAILS_CLASS} segment-tooltip`,
      maxWidth: "none",
      offset: TOOLTIP_OFFSET_PX,
    }));
    if (segment !== this.hovered) {
      this.hovered = segment;
      tooltip.setHTML(this.paths.describe(segment));
      this.onHover?.(segment);
    }
    if (!tooltip.isOpen()) {
      // A popup that tracks the pointer has no place until the pointer
      // moves again, and sits in the corner of the map until then. Opened
      // at a position first, it starts out where the pointer is.
      tooltip.setLngLat(map.unproject(point)).addTo(map).trackPointer();
    }
    map.getCanvas().style.cursor = "pointer";
  }

  private hideTooltip(): void {
    this.hovered = null;
    if (!this.tooltip?.isOpen()) return;
    this.tooltip.remove();
    this.onHover?.(null);
    const canvas = this.app.map?.getCanvas();
    if (canvas) canvas.style.cursor = "";
  }
}

/**
 * The run a feature stands for, if any. Tiles cut from the data before the
 * last `setData` still answer for a while, with indices into a table that
 * is gone: "outdated".
 */
function runOf(
  feature: MapGeoJSONFeature,
  drawn: RunsOnLayer,
): HoverRun | "outdated" | null {
  const { r, g } = feature.properties as Partial<PathRunProperties>;
  if (g !== drawn.table.g) return "outdated";
  return r === undefined ? null : (drawn.table.runs[r] ?? null);
}

/**
 * Whether `candidate` is nearer than `best`, or as near and on a
 * selection's layer where `best` is not: the selection is drawn on top
 */
function isBetter(candidate: Candidate, best: Candidate | null): boolean {
  const distance = best?.distance ?? Infinity;
  return (
    candidate.distance < distance ||
    (candidate.distance === distance && candidate.selected && !best?.selected)
  );
}
