/**
 * Airport labels - the ICAO codes beside the airport markers
 *
 * The markers are DOM, a button round each dot that takes focus and opens
 * its popup from the keyboard, and each carries its code: a chip on a stem
 * from the ring of its dot. Where airports lie closer than the 24 pixel
 * squares their buttons take a press in, the chip of the one that places
 * later becomes its button instead (AirportCodes.target), so no two
 * airports' targets overlap. The codes are placed on the screen around their
 * dots (calculations/codePlacement.ts): above, or wherever round the dot
 * there is room, out on a longer stem where it is crowded, and left out
 * only where nothing is free. Their custom properties turn an arm round the
 * dot, so a code that has to move glides there rather than jumping.
 *
 * The codes were a symbol layer of the map for a while (ee073d13): DOM
 * codes until then were kept apart from one another, but the place names
 * of the base style were placed by the map without knowing of them, and a
 * code sat right on the name of the town beside its airport. A label of the
 * map cannot glide, though: the map lays it out once for the zoom of its
 * tile, so it can only jump to another place or fade there. So the codes
 * are DOM again, and the map is told of the room they take: an invisible
 * label of their size where each is drawn (airportLabelLayer), and one of
 * the size of each dot (airportDotLayer), both placed first and always, so
 * the place names give way to them as to any other label. They are written
 * once the codes are at rest; while the map moves, the place names stand
 * where they were. On a tilted map the map draws a label smaller the
 * farther it is (its perspective ratio), and the code's stand-in is made
 * as much larger, so the room it takes stays the code's; only the dots'
 * stand-ins shrink and grow with the distance, a few pixels either way.
 *
 * On a tilted map (the 3D view) a code is a pin: its chip and stem drawn
 * smaller the farther it is and larger the nearer, as the map draws its
 * labels, within bounds that keep it readable, and standing straight up
 * from its dot before it turns aside (calculations/codePlacement.ts). One
 * the relief hides is hidden with its dot: the map marks its marker
 * covered, and the stylesheet fades both out.
 */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from "maplibre-gl";
import {
  AIRPORT_HIDE_LABELS_BELOW_ZOOM,
  AIRPORT_HIDE_MARKERS_BELOW_ZOOM,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../utils/constants";
import { isPhoneLayout } from "../utils/device";
import { isBehindGlobe } from "../utils/mapHelpers";
import {
  AIRPORT_MARKER_CLASS,
  setAirportTarget,
  type AirportTarget,
} from "../features/airports";
import { DEGREES_TO_RADIANS, focalLengthPx } from "../utils/geometry";
import {
  placeCodes,
  type Box,
  type CodeItem,
  type CodePlace,
} from "../calculations/codePlacement";

/**
 * The font of the room a code takes on the map: Roboto, the interface font
 * of the page on Android and Linux, which the base style's glyph server
 * has. A style without a glyph server (the fallback the map starts on, and
 * the stub of the e2e specs) has the map measure the text with a local
 * font of that name instead, and `sans-serif` is the one every browser has.
 */
const AIRPORT_LABEL_FONT = ["Roboto Medium", "Noto Sans Regular", "sans-serif"];

/**
 * Label size by zoom, `[size, zoom, size, ...]`: it grows at the zooms the
 * markers do (AIRPORT_SIZE_ZOOMS), as `--code-size` does in the stylesheet
 */
const LABEL_SIZE_STEPS = [11, 9, 12, 13, 13] as const;

/** Nothing on a phone reads smaller than its `--text-xs`. Pixels. */
const PHONE_MIN_LABEL_PX = 12;

/**
 * The stand-in of a dot (airportDotLayer): a transparent pixel, scaled to
 * the dot's size
 */
const DOT_IMAGE = "airport-dot-room";

/**
 * The size of a dot with its ring by zoom, `[size, zoom, size, ...]`, in
 * pixels: `--marker-size` and twice `--marker-border` of the zoom's size
 * class in styles.css (AIRPORT_SIZE_ZOOMS)
 */
const DOT_SIZE_STEPS = [8, 5, 9, 7, 10, 9, 14, 11, 15, 13, 16] as const;

/**
 * The stems a code tries, shortest first, in pixels: the gap a code keeps
 * from its dot, then further out where it is crowded. A phone's are a fifth
 * shorter but the first.
 */
const STEMS_PX = [5, 14, 26, 42, 64, 88, 116] as const;
const PHONE_STEM_SCALE = 0.8;

/**
 * Room the map keeps around the text of a code's stand-in, in pixels: the
 * chip's padding and its rim
 */
const RESERVE_PADDING_PX = 4;

/** What a code's chip takes besides its text, in pixels (the stylesheet) */
const CHIP_PAD_X = 6;
const CHIP_PAD_Y = 2;
/** How much narrower the narrower chip is (`.is-narrow`), in pixels */
const NARROW_SAVING_PX = 4;
/** A capital's width and the line's height in ems, for a chip not laid out */
const GLYPH_EM = 0.76;
const LINE_EM = 1.2;

/** Room kept from the edge of the map, in pixels */
const EDGE_PX = 2;

/**
 * Half the square a marker takes the pointer in, `--marker-target` in the
 * stylesheet, in pixels: no code goes into another airport's
 */
const MARKER_TARGET_HALF_PX = 12;

/**
 * The tilt from which a code is a pin (see the module's comment), degrees
 */
const UPRIGHT_PITCH_DEG = 10;

/**
 * How much smaller and larger than its size a pin is drawn at most, by its
 * distance, and the smallest text it is drawn at, in pixels, where the
 * layout has no smallest of its own (a phone's is `PHONE_MIN_LABEL_PX`)
 */
const PIN_SCALE_MIN = 0.7;
const PIN_SCALE_MAX = 1.15;
const PIN_MIN_TEXT_PX = 9;
/**
 * How many steps a pin's scale goes in per 1, so a move does not restyle it
 * in every frame
 */
const PIN_SCALE_STEPS = 20;

/**
 * How much smaller or larger a pin is drawn than its size: as the map draws
 * a label there (its perspective ratio, see AirportCodes.tilt), within
 * `PIN_SCALE_MIN` and `PIN_SCALE_MAX`, never with text smaller than `minPx`
 * (nor `PIN_MIN_TEXT_PX`), in steps of 1 / `PIN_SCALE_STEPS`
 */
export function pinScale(ratio: number, size: number, minPx: number): number {
  const least = Math.max(
    PIN_SCALE_MIN,
    Math.max(minPx, PIN_MIN_TEXT_PX) / size,
  );
  const scale = Math.min(PIN_SCALE_MAX, Math.max(least, ratio));
  return Math.round(scale * PIN_SCALE_STEPS) / PIN_SCALE_STEPS;
}

/**
 * Below this perspective ratio the map leaves a label out altogether (its
 * `perspectiveRatioCutoff`), so a code's stand-in that far off takes no
 * room
 */
const PERSPECTIVE_CUTOFF = 0.6;

/**
 * How long the map has to be at rest before the codes take their best
 * places again, in milliseconds
 */
const SETTLE_MS = 150;

/**
 * How many codes left out look for a place again in a frame of a move, in
 * turn. Each looks at every place round its dot, which in a crowd is the
 * most a frame can cost; at rest all of them look.
 */
const RETRIES_PER_FRAME = 3;

/**
 * How long a panel over the map takes to come or go, in milliseconds: the
 * codes take their places again once it has
 */
const PANEL_SETTLE_MS = 350;

/**
 * What lies over the map and takes room from the codes: a code goes beside
 * a panel rather than under it
 */
const CHROME_SELECTOR = [
  "#left-buttons",
  "#right-buttons",
  "#stats-rail",
  "#mobile-bar",
  "#replay-controls",
  "#selection-chip",
  "#flight-profile",
  "#cross-section",
  ".color-legend",
  ".maplibregl-ctrl-attrib",
].join(", ");

/** What an airport's label says without an ICAO code of its own */
export const NO_CODE_LABEL = "APT";

/**
 * The part of the map that shows, in its pixels, inside its edges: the map
 * as large as an element around it that clips it lets it show (the frame
 * of the Wrapped dialog, with its rounded corners, clips it)
 */
function shownPart(container: HTMLElement, box: DOMRect): Box {
  let l = box.left;
  let t = box.top;
  let r = box.right;
  let b = box.bottom;
  for (let at = container.parentElement; at; at = at.parentElement) {
    if (getComputedStyle(at).overflow === "visible") continue;
    const clip = at.getBoundingClientRect();
    l = Math.max(l, clip.left);
    t = Math.max(t, clip.top);
    r = Math.min(r, clip.right);
    b = Math.min(b, clip.bottom);
  }
  // A map not laid out (a test's document) is as large as it says
  if (r <= l || b <= t) {
    r = l + container.clientWidth;
    b = t + container.clientHeight;
  }
  return {
    l: l - box.left + EDGE_PX,
    t: t - box.top + EDGE_PX,
    r: r - box.left - EDGE_PX,
    b: b - box.top - EDGE_PX,
  };
}

/** The value of a `[value, zoom, value, ...]` step list at `zoom` */
function stepAt(steps: readonly number[], zoom: number): number {
  let value = steps[0]!;
  for (let i = 1; i < steps.length; i += 2) {
    if (zoom >= steps[i]!) value = steps[i + 1]!;
  }
  return value;
}

/** The smallest size of a code in the current layout, in pixels */
function minLabelPx(): number {
  return isPhoneLayout() ? PHONE_MIN_LABEL_PX : 0;
}

/**
 * The room of the codes on the map: an invisible label, the code's text,
 * where its chip is drawn (`o`, ems from the airport) and as large as the
 * chip is drawn (`s`, pixels, see AirportCodes.reserve), created hidden
 * like every layer of the app. Placed whatever it overlaps, and before the
 * place names of the style (it is above them), it takes its room from them.
 */
export function airportLabelLayer(): SymbolLayerSpecification {
  return {
    id: MAP_LAYERS.airportLabels,
    type: "symbol",
    source: MAP_SOURCES.airportLabels,
    minzoom: AIRPORT_HIDE_MARKERS_BELOW_ZOOM,
    filter: ["has", "o"],
    layout: {
      visibility: "none",
      "text-field": ["get", "icao"],
      "text-font": AIRPORT_LABEL_FONT,
      "text-size": ["get", "s"],
      "text-letter-spacing": 0.05,
      "text-offset": ["array", "number", 2, ["get", "o"]],
      "text-padding": RESERVE_PADDING_PX,
      "text-allow-overlap": true,
    },
    paint: { "text-opacity": 0 },
  };
}

/**
 * The stand-ins of the dots, of the label source: a symbol the size of each
 * dot that draws nothing, placed first and always, which the place names
 * give way to. Shown and hidden with the labels.
 */
export function airportDotLayer(): SymbolLayerSpecification {
  return {
    id: MAP_LAYERS.airportDots,
    type: "symbol",
    source: MAP_SOURCES.airportLabels,
    minzoom: AIRPORT_HIDE_MARKERS_BELOW_ZOOM,
    layout: {
      visibility: "none",
      "icon-image": DOT_IMAGE,
      "icon-size": [
        "step",
        ["zoom"],
        ...DOT_SIZE_STEPS,
      ] as ExpressionSpecification,
      "icon-allow-overlap": true,
      "icon-padding": 0,
    },
  };
}

/** Add the stand-in of a dot to the map, unless it has it */
function addImages(map: MapLibreMap): void {
  if (!map.hasImage(DOT_IMAGE)) {
    map.addImage(DOT_IMAGE, { width: 1, height: 1, data: new Uint8Array(4) });
  }
}

/**
 * Give the map the stand-in of a dot. It is part of no style: a base style
 * that replaces the map's style may drop it, and the map asks for a missing
 * image by name, which is when it gets it again.
 */
export function addAirportLabelImages(map: MapLibreMap): void {
  addImages(map);
  map.on("styleimagemissing", (event: { id: string }) => {
    if (event.id === DOT_IMAGE) addImages(map);
  });
}

/** An airport whose code is placed: its marker, and where it is */
export interface CodeMarker {
  name: string;
  element: HTMLElement;
  lng: number;
  lat: number;
}

/** A marker whose dot is drawn on the map, and where, in its pixels */
interface Drawn {
  marker: CodeMarker;
  x: number;
  y: number;
}

/** What the codes are placed for */
export interface CodeHost {
  readonly map: MapLibreMap;
  /** The airports shown, the one whose code is placed first first */
  ranked(): readonly CodeMarker[];
  /**
   * Whether the map is an overview of the flights (Wrapped's), which shows
   * every code it has room for, at any zoom its markers show at, and which
   * none of the page's panels lies over
   */
  overview(): boolean;
  /** Told when an airport's code has gone elsewhere, or out */
  moved(name: string): void;
}

/** A chip's size, and the layout it was measured in */
interface ChipSize {
  w: number;
  h: number;
  key: string;
}

/**
 * Where the codes go, worked out again as the map moves (see the module's
 * comment). Each frame of a move keeps every code where it is unless that
 * is taken; at rest every code takes its best place.
 */
export class AirportCodes {
  private places = new Map<string, CodePlace | null>();
  /** The angle each code is drawn at, unwound so it turns the short way */
  private readonly angles = new Map<string, number>();
  private readonly sizes = new WeakMap<HTMLElement, ChipSize>();
  private taken: Box[] = [];
  /**
   * The squares the map's other markers take the pointer in (otherTargets),
   * which the codes keep off and the airports' squares give way to
   */
  private others: { x: number; y: number; half: number }[] = [];
  /** Where a chip may go: the part of the map that shows */
  private bounds: Box | null = null;
  /** The map's size, measured with the bounds rather than in every frame */
  private width = 0;
  private height = 0;
  private frame = 0;
  private settleNext = false;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private panelTimer: ReturnType<typeof setTimeout> | undefined;
  /** What was last written to the room the codes take, as text */
  private reserved = "";
  /** The source it was written to: a new style makes a new one */
  private reservedIn: GeoJSONSource | null = null;
  /** Which of the codes left out looks for a place next in a move */
  private nextRetry = 0;

  constructor(
    private readonly host: CodeHost,
    signal: AbortSignal,
  ) {
    const map = host.map;
    const move = (): void => {
      clearTimeout(this.settleTimer);
      this.schedule(false);
    };
    const rest = (): void => {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.schedule(true), SETTLE_MS);
    };
    const resize = (): void => {
      this.bounds = null;
      this.schedule(true);
    };
    map.on("move", move);
    map.on("moveend", rest);
    map.on("resize", resize);
    const panels = this.followPanels();
    signal.addEventListener("abort", () => {
      map.off("move", move);
      map.off("moveend", rest);
      map.off("resize", resize);
      panels();
      clearTimeout(this.settleTimer);
      clearTimeout(this.panelTimer);
      cancelAnimationFrame(this.frame);
    });
  }

  /**
   * Place the codes again when a panel over the map comes, goes or changes
   * its size without the map changing its own: the selection's chip, the
   * flight profile, the cross-section. Panels made later (those two) are
   * followed from when they are added to the page. What changes a panel's
   * size is followed (its attributes, what it holds) rather than the size
   * itself: a ResizeObserver of the panels, which other observers of the
   * page resize in the same frame, made WebKit report a loop of them as an
   * error of the page.
   * @returns What stops following them
   */
  private followPanels(): () => void {
    if (typeof MutationObserver === "undefined") return () => {};
    const changed = (): void => {
      this.schedule(true);
      clearTimeout(this.panelTimer);
      this.panelTimer = setTimeout(() => this.schedule(true), PANEL_SETTLE_MS);
    };
    const panels = new MutationObserver(changed);
    const followed = new WeakSet<Element>();
    /** @returns Whether a panel was new */
    const follow = (): boolean => {
      let found = false;
      for (const element of document.querySelectorAll(CHROME_SELECTOR)) {
        if (followed.has(element)) continue;
        followed.add(element);
        panels.observe(element, {
          attributes: true,
          attributeFilter: ["hidden", "class", "style"],
          childList: true,
        });
        found = true;
      }
      return found;
    };
    follow();
    // A panel added to the page may take room at once
    const added = new MutationObserver(() => follow() && changed());
    added.observe(document.body, { childList: true });
    return () => {
      panels.disconnect();
      added.disconnect();
    };
  }

  /** Where an airport's code is, null for left out */
  placeOf(name: string): CodePlace | null {
    return this.places.get(name) ?? null;
  }

  /**
   * Write the room of the codes to the map at the next placing even if it
   * has not changed: the map lost what it had (a lost WebGL context)
   */
  forgetRoom(): void {
    this.reservedIn = null;
  }

  /** Place the codes at the next frame; at rest, each at its best place */
  schedule(settle: boolean): void {
    this.settleNext ||= settle;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const now = this.settleNext;
      this.settleNext = false;
      this.place(now);
    });
  }

  /**
   * Place the codes now, each at its best place: the airports shown have
   * changed, or their counts, which decide who places first
   */
  update(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.settleNext = false;
    this.place(true);
  }

  private place(settle: boolean): void {
    const { map } = this.host;
    const container = map.getContainer();
    const zoom = map.getZoom();
    const ranked = this.host.ranked();
    // Measured at rest and on a new size only: in a frame of a move, after
    // the map has moved its markers, it would cost a layout of the page
    if (settle || !this.bounds) {
      const box = container.getBoundingClientRect();
      this.taken = this.chrome(box);
      this.others = this.otherTargets();
      this.bounds = shownPart(container, box);
      this.width = box.width || container.clientWidth;
      this.height = box.height || container.clientHeight;
    }
    const { width, height } = this;
    const overview = this.host.overview();
    const shown =
      zoom >=
        (overview
          ? AIRPORT_HIDE_MARKERS_BELOW_ZOOM
          : AIRPORT_HIDE_LABELS_BELOW_ZOOM) &&
      !container.classList.contains("airports-hidden");
    const phone = isPhoneLayout();
    const key = `${container.dataset["zoomSize"] ?? ""}${phone}`;
    const size = Math.max(stepAt(LABEL_SIZE_STEPS, zoom), minLabelPx());
    const tilt = this.tilt();

    // The dots drawn on the map, the first placed first: whose code may go
    // round them, and whose square takes the pointer
    const drawn: Drawn[] = [];
    // Those off the map as well, which a move brings back before the next
    // rest (see reserve)
    const room: Drawn[] = [];
    const under = new Set<CodeMarker>();
    // Zoomed out to where the markers are hidden, no dot is drawn; the map
    // has the room of the dots then all the same, and leaves it out by zoom
    const dots = zoom >= AIRPORT_HIDE_MARKERS_BELOW_ZOOM;
    for (const marker of ranked) {
      const { element } = marker;
      if (element.hidden) continue;
      if (element.classList.contains("maplibregl-marker-covered")) continue;
      if (isBehindGlobe(map, marker)) continue;
      const { x, y } = map.project([marker.lng, marker.lat]);
      if (!dots || x < 0 || y < 0 || x > width || y > height) {
        room.push({ marker, x, y });
        continue;
      }
      // Under a panel the dot does not show, nor would its code
      if (
        this.taken.some(
          (box) => x > box.l && x < box.r && y > box.t && y < box.b,
        )
      ) {
        under.add(marker);
        continue;
      }
      drawn.push({ marker, x, y });
      room.push({ marker, x, y });
    }

    const items: CodeItem[] = [];
    for (const { marker, x, y } of shown ? drawn : []) {
      const chip = this.sizeOf(marker.element, key, size);
      items.push({
        name: marker.name,
        x,
        y,
        w: chip.w,
        h: chip.h,
        narrow: chip.w - NARROW_SAVING_PX,
        scale: tilt ? pinScale(tilt(y), size, minLabelPx()) : 1,
      });
    }

    const scale = phone ? PHONE_STEM_SCALE : 1;
    const places = placeCodes(
      items,
      {
        dot: stepAt(DOT_SIZE_STEPS, zoom) / 2,
        target: MARKER_TARGET_HALF_PX,
        press: 2 * MARKER_TARGET_HALF_PX,
        bounds: this.bounds,
        taken: this.taken,
        targets: this.others.map(({ x, y, half }) => ({
          l: x - half,
          t: y - half,
          r: x + half,
          b: y + half,
        })),
        stems: STEMS_PX.map((stem, index) => (index ? stem * scale : stem)),
        upright: tilt !== null,
      },
      this.places,
      settle,
      settle || this.retries(items),
    );

    for (const marker of ranked) {
      const place = places.get(marker.name) ?? null;
      if (this.draw(marker, place, this.places.get(marker.name) ?? null)) {
        this.host.moved(marker.name);
      }
    }
    this.places = places;
    if (settle) {
      this.reserve(room, size);
      this.target(ranked, drawn, under);
    }
  }

  /**
   * Make each airport's target the part of its marker that takes the
   * pointer and the focus (setAirportTarget), so no two airports' targets
   * overlap: the square round its dot where that lies clear of the squares
   * of the airports placed before it, its code's chip where it does not
   * and the code is drawn (placement keeps chips off every square), and
   * otherwise the largest square clear of the others, which is smaller
   * than the 24 pixels a finger is asked for. That is left for a crowd
   * with no room for a code at all. A marker a panel lies over takes
   * nothing: it cannot be seen, a tap there is the panel's, and the
   * keyboard is not to go behind it; the one that has the focus keeps it.
   * Markers not drawn (hidden by the zoom, the relief, the globe, or off
   * the map) keep their full square.
   */
  private target(
    ranked: readonly CodeMarker[],
    drawn: readonly Drawn[],
    under: ReadonlySet<CodeMarker>,
  ): void {
    const targets = new Map<CodeMarker, AirportTarget>();
    // The map's other markers come first: replay's airplane is a button
    // that takes the pointer wherever it flies
    const squares = [...this.others];
    for (const { marker, x, y } of drawn) {
      let half = MARKER_TARGET_HALF_PX;
      for (const square of squares) {
        const apart = Math.max(Math.abs(x - square.x), Math.abs(y - square.y));
        half = Math.min(half, apart - square.half);
      }
      if (half < MARKER_TARGET_HALF_PX && this.places.get(marker.name)) {
        targets.set(marker, { chip: true, half: null, out: false });
        continue;
      }
      half = Math.max(half, 0);
      squares.push({ x, y, half });
      targets.set(marker, {
        chip: false,
        half: half < MARKER_TARGET_HALF_PX ? half : null,
        out: false,
      });
    }
    for (const marker of ranked) {
      const out =
        under.has(marker) && !marker.element.contains(document.activeElement);
      setAirportTarget(
        marker.element,
        targets.get(marker) ?? { chip: false, half: null, out },
      );
    }
  }

  /**
   * The squares the map's markers other than the airports' take the
   * pointer in, in its pixels: half their size about their middle
   */
  private otherTargets(): { x: number; y: number; half: number }[] {
    const container = this.host.map.getContainer();
    const box = container.getBoundingClientRect();
    const squares: { x: number; y: number; half: number }[] = [];
    for (const element of container.querySelectorAll<HTMLElement>(
      ".maplibregl-marker:not(." + AIRPORT_MARKER_CLASS + ")",
    )) {
      if (element.hidden) continue;
      const r = element.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      squares.push({
        x: (r.left + r.right) / 2 - box.left,
        y: (r.top + r.bottom) / 2 - box.top,
        half: Math.max(r.width, r.height) / 2,
      });
    }
    return squares;
  }

  /**
   * The codes left out that look for a place again in this frame of a
   * move: a few of them, the next few in the next frame
   */
  private retries(items: readonly CodeItem[]): ReadonlySet<string> {
    const out = items.filter((item) => this.places.get(item.name) === null);
    const looking = new Set<string>();
    if (out.length === 0) return looking;
    for (let i = 0; i < Math.min(RETRIES_PER_FRAME, out.length); i++) {
      looking.add(out[(this.nextRetry + i) % out.length]!.name);
    }
    this.nextRetry = (this.nextRetry + RETRIES_PER_FRAME) % out.length;
    return looking;
  }

  /**
   * The size of an airport's chip as drawn, its face, measured once per
   * layout: the full chip's, whether it is drawn narrower now or not
   */
  private sizeOf(element: HTMLElement, key: string, size: number): ChipSize {
    const known = this.sizes.get(element);
    if (known?.key === key) return known;
    const chip = element.querySelector<HTMLElement>(".airport-code");
    // The face, as drawn: the chip round it is at least a finger's size
    const face = chip?.querySelector<HTMLElement>(".airport-code-face");
    const text = chip?.textContent ?? NO_CODE_LABEL;
    const narrowed = chip?.classList.contains("is-narrow")
      ? NARROW_SAVING_PX
      : 0;
    // A chip not laid out (a test's document) is as large as its text
    const measured = {
      w: face?.offsetWidth
        ? face.offsetWidth + narrowed
        : text.length * GLYPH_EM * size + 2 * CHIP_PAD_X,
      h: face?.offsetHeight || LINE_EM * size + 2 * CHIP_PAD_Y,
      key,
    };
    this.sizes.set(element, measured);
    return measured;
  }

  /** The panels over the map, in its pixels */
  private chrome(box: DOMRect): Box[] {
    if (this.host.overview()) return [];
    const taken: Box[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      CHROME_SELECTOR,
    )) {
      if (element.hidden || getComputedStyle(element).visibility === "hidden") {
        continue;
      }
      const r = element.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      taken.push({
        l: r.left - box.left,
        t: r.top - box.top,
        r: r.right - box.left,
        b: r.bottom - box.top,
      });
    }
    return taken;
  }

  /**
   * Draw a code where it goes, or leave it out. A code shown again goes
   * there at once, and only fades in.
   * @returns Whether it went elsewhere
   */
  private draw(
    marker: CodeMarker,
    place: CodePlace | null,
    before: CodePlace | null,
  ): boolean {
    const arm = marker.element.querySelector<HTMLElement>(".airport-code-arm");
    if (!arm) return false;
    const hidden = arm.classList.contains("is-hidden");
    if (!place) {
      arm.classList.add("is-hidden");
      return !hidden;
    }
    if (
      !hidden &&
      before &&
      before.angle === place.angle &&
      before.at === place.at &&
      before.to === place.to &&
      before.narrow === place.narrow &&
      before.scale === place.scale
    ) {
      return false;
    }
    let angle = place.angle;
    const last = this.angles.get(marker.name);
    if (last !== undefined) angle += 360 * Math.round((last - angle) / 360);
    this.angles.set(marker.name, angle);
    arm.classList.toggle("is-jump", hidden);
    arm.style.setProperty("--code-angle", `${angle}deg`);
    arm.style.setProperty("--code-at", `${place.at}px`);
    arm.style.setProperty("--code-from", `${place.from}px`);
    arm.style.setProperty("--code-stem", `${place.to - place.from}`);
    arm.style.setProperty("--code-scale", `${place.scale}`);
    arm
      .querySelector(".airport-code")
      ?.classList.toggle("is-narrow", place.narrow);
    arm.classList.remove("is-hidden");
    if (hidden) {
      // Its new place is styled now, while it jumps: otherwise a frame that
      // ends the jump before the page has styled it, as when it is drawn
      // outside a frame of the map, has it glide from where it was
      void getComputedStyle(arm).transform;
      requestAnimationFrame(() => arm.classList.remove("is-jump"));
    }
    return true;
  }

  /**
   * Tell the map of the room the codes take, where they are now: every dot
   * drawn on the map has its own (not one the relief, the globe or a panel
   * hides), the ones whose code is drawn their chip's too, `o` ems from the airport at a label size of `s`: the size the code
   * is drawn at (its pin's scale), made larger by as much as the map draws
   * a label smaller there
   */
  private reserve(drawn: readonly Drawn[], size: number): void {
    const map = this.host.map;
    const source = map.getSource<GeoJSONSource>(MAP_SOURCES.airportLabels);
    if (!source) return;
    const ratioAt = this.ratioAt();
    const features = drawn.map(({ marker: { name, element, lng, lat }, y }) => {
      const place = this.places.get(name);
      const properties: Record<string, unknown> = { name };
      const ratio = place ? (ratioAt?.(y) ?? 1) : 0;
      if (place && ratio >= PERSPECTIVE_CUTOFF) {
        const radians = (place.angle * Math.PI) / 180;
        const drawnSize = size * place.scale;
        properties["icao"] =
          element.querySelector(".airport-code")?.textContent ?? "";
        properties["s"] = drawnSize / ratio;
        properties["o"] = [
          (place.at * Math.cos(radians)) / drawnSize,
          (place.at * Math.sin(radians)) / drawnSize,
        ];
      }
      return {
        type: "Feature" as const,
        properties,
        geometry: { type: "Point" as const, coordinates: [lng, lat] },
      };
    });
    // Placed again with nothing changed (a panel that came and went, a
    // settle after a settle), the map has nothing to lay out again
    const data = { type: "FeatureCollection" as const, features };
    const text = JSON.stringify(data);
    if (text === this.reserved && source === this.reservedIn) return;
    this.reserved = text;
    this.reservedIn = source;
    void source.setData(data);
  }

  /**
   * How much smaller than its size the map draws a label by how far down
   * the map it is, as MapLibre works it out: half and half of its own size
   * and of its size by its distance from the camera, which on a map tilted
   * by `pitch` is the less the lower it is drawn (see cameraDistanceRatio).
   * Worked out once for a placing; null for a map seen from straight
   * above, and on the globe, which tilts little (a ratio of 1).
   */
  private ratioAt(): ((y: number) => number) | null {
    const map = this.host.map;
    const pitch = map.getPitch() * DEGREES_TO_RADIANS;
    if (pitch === 0 || map.getProjection()?.type === "globe") return null;
    const fov = map.getVerticalFieldOfView() * DEGREES_TO_RADIANS;
    const focal = focalLengthPx(this.height, fov);
    const middle = map.project(map.getCenter()).y;
    const slope = (0.5 * Math.tan(pitch)) / focal;
    return (y) => 1 + (y - middle) * slope;
  }

  /**
   * On a map tilted enough for the codes to be pins (`UPRIGHT_PITCH_DEG`),
   * the perspective ratio by how far down the map a place is; null when
   * they are not
   */
  private tilt(): ((y: number) => number) | null {
    if (this.host.overview()) return null;
    if (this.host.map.getPitch() < UPRIGHT_PITCH_DEG) return null;
    return this.ratioAt() ?? (() => 1);
  }
}
