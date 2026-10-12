/**
 * Inline SVG icon set.
 *
 * The shapes come from Lucide (ISC, https://lucide.dev), imported by name so
 * the bundler keeps only the ones this page draws. Three are drawn here
 * instead: Lucide carries no brand marks, the replay marker needs an
 * aircraft seen from above, which no general purpose set has, and Stop is
 * a filled square.
 *
 * They are inlined rather than drawn from an icon font: an icon is part of
 * the markup it is drawn into, so it shows with the first paint, needs no
 * request of its own and takes its colour from the text around it. Every
 * shape uses `currentColor`, so one colour rule drives them, and one family
 * on a 24px grid means one stroke weight per size: 24px at 1.45, 20px at
 * 1.5, 16px at 1.6.
 */
import {
  ArrowUpFromLine,
  Calendar,
  Camera,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Crosshair,
  Earth,
  Ellipsis,
  ExternalLink,
  Flame,
  Gauge,
  Globe,
  Box,
  Info,
  Layers,
  Link2,
  LocateFixed,
  MapPin,
  Menu,
  Milestone,
  Mountain,
  Navigation,
  Pause,
  Plane,
  Play,
  RotateCcw,
  Route,
  Satellite,
  Ruler,
  Search,
  SlidersHorizontal,
  Star,
  Trophy,
  X,
  ZoomIn,
  type IconNode,
} from "lucide";
import { escapeHtml } from "./escape";
import { logError } from "./logger";

export type IconName =
  | "stats"
  | "export"
  | "share"
  | "wrapped"
  | "play"
  | "pause"
  | "stop"
  | "isolate"
  | "heatmap"
  | "airport"
  | "altitude"
  | "speed"
  | "distance"
  | "aviation"
  | "layers"
  | "filter"
  | "chevronDown"
  | "chevronRight"
  | "collapse"
  | "autoZoom"
  | "close"
  | "aircraft"
  | "chase"
  | "calendar"
  | "more"
  | "github"
  | "info"
  | "globe"
  | "threeD"
  | "satellite"
  | "compass"
  | "clock"
  | "trophy"
  | "externalLink"
  | "earth"
  | "milestone"
  | "ruler"
  | "climb"
  | "reset"
  | "search"
  | "aircraftTop";

/**
 * The shapes Lucide does not carry. The GitHub mark is a brand, which the
 * set dropped on purpose; the aircraft is drawn nose up and solid, so the
 * replay marker's rotation is the track itself and the silhouette holds
 * together over live map data. Stop is filled, as on a player: Lucide's
 * outlined square, which the replays and the hotspot tour swap their
 * control's icon to while they run, looked like an empty checkbox.
 */
const OWN_PATHS = {
  github:
    '<path d="M12 2.5A9.5 9.5 0 0 0 9 21.2c.5.1.7-.2.7-.5v-1.7C7.1 19.6 6.5 18 6.5 18a2.5 2.5 0 0 0-1-1.4c-.8-.6.1-.6.1-.6a2 2 0 0 1 1.4 1 2 2 0 0 0 2.7.8 2 2 0 0 1 .6-1.3c-2-.2-4.2-1-4.2-4.7a3.6 3.6 0 0 1 1-2.5 3.4 3.4 0 0 1 .1-2.5s.8-.3 2.7 1a9.2 9.2 0 0 1 4.8 0c1.9-1.3 2.7-1 2.7-1a3.4 3.4 0 0 1 .1 2.5 3.6 3.6 0 0 1 1 2.5c0 3.7-2.2 4.5-4.2 4.7a2.3 2.3 0 0 1 .6 1.7v2.5c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z"/>',
  aircraftTop:
    '<path d="M12 2.6c1.1 0 1.8 1.3 1.8 2.8v3.1l6.7 3.9v2.2l-6.7-2v4.2l2.2 1.6v1.6L12 19.3l-4 .7v-1.6l2.2-1.6v-4.2l-6.7 2v-2.2l6.7-3.9V5.4c0-1.5.7-2.8 1.8-2.8z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/>',
} as const;

/** What each name in the interface is drawn as */
const NODES: Record<Exclude<IconName, keyof typeof OWN_PATHS>, IconNode> = {
  stats: ChartNoAxesColumn,
  export: Camera,
  share: Link2,
  wrapped: Star,
  play: Play,
  pause: Pause,
  isolate: Crosshair,
  heatmap: Flame,
  airport: MapPin,
  altitude: Mountain,
  speed: Gauge,
  distance: Route,
  aviation: Layers,
  layers: Menu,
  filter: SlidersHorizontal,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  collapse: ChevronLeft,
  autoZoom: ZoomIn,
  close: X,
  aircraft: Plane,
  // The chase view keeps the camera on the aircraft, which the glyph of a
  // map that follows a position says; the arrow is the compass's
  chase: LocateFixed,
  calendar: Calendar,
  more: Ellipsis,
  info: Info,
  globe: Globe,
  threeD: Box,
  satellite: Satellite,
  // An arrow rather than Lucide's compass rose: the control turns it to
  // where north is, and the rose reads the same from every side. It points
  // north-east; the stylesheet turns it upright.
  compass: Navigation,
  clock: Clock,
  trophy: Trophy,
  externalLink: ExternalLink,
  earth: Earth,
  milestone: Milestone,
  ruler: Ruler,
  // A climb
  climb: ArrowUpFromLine,
  reset: RotateCcw,
  search: Search,
};

/** One Lucide node list as the markup that goes inside an `<svg>` */
function nodesToMarkup(nodes: IconNode): string {
  return nodes
    .map(([tag, attrs]) => {
      const written = Object.entries(attrs)
        .map(([attribute, value]) => `${attribute}="${String(value)}"`)
        .join(" ");
      return `<${tag} ${written}/>`;
    })
    .join("");
}

/** Geometry only; the wrapper supplies size, stroke and colour. */
const PATHS: Record<IconName, string> = {
  ...OWN_PATHS,
  ...(Object.fromEntries(
    Object.entries(NODES).map(([name, nodes]) => [name, nodesToMarkup(nodes)]),
  ) as Record<Exclude<IconName, keyof typeof OWN_PATHS>, string>),
};

/**
 * How an icon is painted. The family is an outline family; `solid` exists for
 * the one place an outline loses, a marker drawn over live map data.
 */
export type IconVariant = "outline" | "solid";

/**
 * Stroke weight paired with each size, so density reads evenly.
 *
 * A hair under a pixel and a half at the largest size, lifting as the icon
 * shrinks and the same stroke would start to look faint. They were a step
 * heavier, which read as solid rather than drawn beside 13px text.
 */
const STROKE_FOR_SIZE: Record<number, string> = {
  16: "1.6",
  20: "1.5",
  24: "1.45",
};

const ICON_SIZES = [16, 20, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** Icon size of the dense desktop control rows */
export const DEFAULT_ICON_SIZE: IconSize = 16;

/** Whether a string, typically a `data-icon` attribute, names a known icon */
export function isIconName(name: string | undefined): name is IconName {
  return (
    name !== undefined && Object.prototype.hasOwnProperty.call(PATHS, name)
  );
}

/**
 * Size a control is drawn at: the size last applied to it, recorded in
 * `data-icon-size`, falling back to the dense row size.
 */
export function iconSizeOf(el: HTMLElement): IconSize {
  const declared = Number(el.dataset["iconSize"]);
  return ICON_SIZES.includes(declared as IconSize)
    ? (declared as IconSize)
    : DEFAULT_ICON_SIZE;
}

/**
 * Markup for one icon. Only `title` reaches the output from a caller, and it
 * is attribute-escaped, so the result is safe to insert with innerHTML
 * alongside escaped content.
 *
 * @param name - Icon to draw
 * @param size - One of the three sizes on the scale
 * @param title - Accessible name; omit for icons beside a text label
 * @param variant - `solid` for a marker over map data, outline everywhere else
 */
export function icon(
  name: IconName,
  size: IconSize = 20,
  title?: string,
  variant: IconVariant = "outline",
): string {
  const stroke = STROKE_FOR_SIZE[size] ?? "1.8";
  const label = title
    ? ' role="img" aria-label="' + escapeHtml(title) + '"'
    : ' aria-hidden="true" focusable="false"';
  const paint =
    variant === "solid"
      ? ' fill="currentColor" stroke="none"'
      : ' fill="none" stroke="currentColor" stroke-width="' +
        stroke +
        '" stroke-linecap="round" stroke-linejoin="round"';
  return (
    '<svg class="icon" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24"' +
    paint +
    label +
    ">" +
    PATHS[name] +
    "</svg>"
  );
}

/**
 * Swap the icon of a control in place.
 *
 * Only the control's own leading `svg.icon` is replaced, so a sibling
 * `.control-label` survives; writing innerHTML here would destroy it. The
 * `data-icon` and `data-icon-size` attributes are updated too, so a later
 * `renderControlIcons()` redraws the state the control is actually in and the
 * swap keeps the size the surrounding chrome last asked for.
 *
 * @param button - Control to draw into
 * @param name - Icon to draw; an unknown name is logged and nothing is drawn
 * @param size - Size to draw at; the control's own size when omitted
 */
export function setControlIcon(
  button: HTMLElement,
  name: IconName,
  size?: IconSize,
): void {
  if (!isIconName(name)) {
    logError(`Unknown icon name: ${String(name)}`);
    return;
  }
  const drawn = size ?? iconSizeOf(button);
  button.dataset["icon"] = name;
  button.dataset["iconSize"] = String(drawn);
  button.querySelector(":scope > svg.icon")?.remove();
  button.insertAdjacentHTML("afterbegin", icon(name, drawn));
}

/**
 * Draw the inline icon of every `[data-icon]` control below `root`.
 * Re-rendering replaces the icon that is already there, so the same element
 * can change size when the chrome becomes icon-only.
 *
 * @param root - Subtree to walk; the whole document by default
 * @param size - Size for every icon; each element's own size when omitted
 */
export function renderControlIcons(
  root: ParentNode = document,
  size?: IconSize,
): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => {
    const name = el.dataset["icon"];
    if (!name) return;
    if (!isIconName(name)) {
      logError(
        `Unknown icon name "${name}" on ${el.id ? `#${el.id}` : el.tagName}`,
      );
      return;
    }
    setControlIcon(el, name, size);
  });
}
