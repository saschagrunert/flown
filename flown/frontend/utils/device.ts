/**
 * What kind of screen and pointer the page is on. Every question the app
 * asks about the device goes through here, so the phone layout means the
 * same to the mobile bar, the labels and the export.
 */
import { MOBILE_BREAKPOINT_PX, PHONE_MAX_HEIGHT_PX } from "./constants";

/**
 * The phone layout: the mobile bar in place of the control columns, below
 * the breakpoint's width or at a phone's height held sideways. Just under
 * the breakpoint, like the stylesheet, so the two agree on a fractional
 * width such as 767.5px.
 */
export const PHONE_LAYOUT_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px), (max-height: ${PHONE_MAX_HEIGHT_PX}px)`;

/** The lists of the queries asked, and the matchMedia they came from */
let lists = new Map<string, MediaQueryList>();
let listsOf: unknown = null;

/**
 * The list of a media query, null where there are none (jsdom). One per
 * query: a MediaQueryList follows the page by itself, and the hover of the
 * pointer asks on every frame.
 */
function mediaList(query: string): MediaQueryList | null {
  if (typeof window.matchMedia !== "function") return null;
  // Compared, never called unbound: a page given another matchMedia (a
  // test's) asks it anew
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const matchMedia = window.matchMedia;
  if (listsOf !== matchMedia) {
    lists = new Map();
    listsOf = matchMedia;
  }
  let list = lists.get(query);
  if (!list) {
    list = window.matchMedia(query);
    lists.set(query, list);
  }
  return list;
}

/** Whether the page matches a media query; false where there are none */
export function matchesMedia(query: string): boolean {
  return mediaList(query)?.matches ?? false;
}

/**
 * Whether the page has the phone layout. Without media queries (jsdom), by
 * the size of the window.
 */
export function isPhoneLayout(): boolean {
  return (
    mediaList(PHONE_LAYOUT_QUERY)?.matches ??
    (window.innerWidth < MOBILE_BREAKPOINT_PX ||
      window.innerHeight <= PHONE_MAX_HEIGHT_PX)
  );
}

/**
 * Whether the pointer cannot hover, so tooltips need a tap instead. Touch
 * support alone does not say: a laptop with a touchscreen is driven by its
 * mouse most of the time, and lost the hover tooltips for having one.
 */
export function isTouchDevice(): boolean {
  return (
    mediaList("(hover: none)")?.matches ??
    ("ontouchstart" in window || navigator.maxTouchPoints > 0)
  );
}

/**
 * Milliseconds after a touch in which a click or a move of the mouse is
 * the browser's for the tap, not one of a mouse. Counted from the end of
 * the touch: a long press, or a tap while the page is busy, ends well
 * after it began, and its click comes after the end.
 */
const TAP_MS = 1000;

/**
 * Tells a finger's clicks from a mouse's, one for the app (MapApp's
 * `touchClock`), which the map's touches are noted on. The click
 * dispatcher and the readout of the heat cloud told them apart each in a
 * way of their own, by the click's pointerType and by the time since a
 * touch, and on a touch laptop whose clicks carry no pointerType the two
 * could disagree about one click.
 */
export class TouchClock {
  /**
   * When the map was last touched, by the clock of its events: the start
   * of a touch, then its end
   */
  private touchedAt = -Infinity;

  /**
   * A touch on the map, as it starts and again as it ends (or is
   * cancelled). Measured from the start alone, a press of about a second
   * was over by the time of its click, which then counted as a mouse's and
   * toggled a flight on iOS, whose click for a tap says "mouse".
   */
  note(event: Event): void {
    this.touchedAt = Math.max(this.touchedAt, event.timeStamp);
  }

  /**
   * Whether an event of the mouse is the browser's for a touch just before:
   * within TAP_MS of it on either side. Events are handled in the order
   * they come, so one stamped before the touch that is handled after it is
   * the browser's for it: a click WebKit stamps at or before the end of
   * the touch it makes it for, or by a clock of its own, counted as a
   * mouse's.
   */
  follows(event: Event): boolean {
    return Math.abs(event.timeStamp - this.touchedAt) < TAP_MS;
  }

  /**
   * Whether a click was a finger's, by the evidence of a touch: a click
   * that says so itself (a pointer event, in the browsers that make a
   * click one), or one a touch came just before, which a tap always has:
   * WebKit's click for a tap may say nothing of its pointer, or "mouse".
   * Never by the device: a page that cannot hover (an iPad) may still be
   * clicked with a trackpad, whose click toggles a flight as a mouse's.
   */
  isTouchClick(event: Event): boolean {
    const type = (event as Partial<PointerEvent>).pointerType;
    return type === "touch" || this.follows(event);
  }
}

/**
 * Whether a link goes to the native share sheet rather than the clipboard:
 * in the phone layout alone. A tablet or a touch laptop has the control
 * columns, whose control says "Copy link".
 */
export function canShareLink(): boolean {
  return isPhoneLayout() && typeof navigator.share === "function";
}

/** What a control that hands the link on says (see canShareLink) */
export function shareLinkLabel(): string {
  return canShareLink() ? "Share link" : "Copy link";
}

/**
 * Call `fn` whenever the page goes into the phone layout or out of it,
 * with whether it has it now; returns the way to stop. The one listener
 * for the bar that takes the place of the columns and for the labels that
 * change with it, such as shareLinkLabel's.
 */
export function followPhoneLayout(fn: (phone: boolean) => void): () => void {
  const list = mediaList(PHONE_LAYOUT_QUERY);
  const listener = (event: MediaQueryListEvent): void => fn(event.matches);
  list?.addEventListener("change", listener);
  return () => list?.removeEventListener("change", listener);
}

/**
 * A phone or a tablet: the phone layout, or a finger for a pointer. These
 * get the share sheet where a desktop copies a link or downloads a file.
 */
export function isSmallDevice(): boolean {
  return isPhoneLayout() || matchesMedia("(pointer: coarse)");
}
