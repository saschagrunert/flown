/**
 * The on/off switches of the app, in one table. Each is a boolean store key
 * that a session keeps and a link carries, and most have a control in the
 * columns (templates/map_template.html) and a row in the phone's sheets.
 * The store's defaults and accessors, the saved state and the link, the
 * button sync, the actions and the sheet rows are all read off this table,
 * so a new switch is one entry here and one handler in ui/actions.ts.
 */
import type { IconName } from "../utils/icons";

/** Where a link carries a toggle (see state/urlState.ts) */
export type ToggleUrl =
  /** A slot of the 9-character `v` string, "1" or "0" */
  | { readonly slot: number }
  /** A parameter of its own, written "1" while on and left out while off */
  | { readonly param: string };

/** A toggle's row in one of the phone's sheets (ui/mobileBar.ts) */
export interface ToggleSheetRow {
  readonly group: "layers" | "more";
  /** The row's `data-row`, which the e2e tests find it by */
  readonly id: string;
  /** Replaces the button's label where the sheet has room for more */
  readonly label?: string;
  readonly chip?: "altitude" | "speed";
}

export interface ToggleSpec {
  readonly key: string;
  /** What a first visit shows, and what Reset view puts back */
  readonly initial: boolean;
  readonly url: ToggleUrl;
  /** The action its control runs (ui/actions.ts) */
  readonly action?: string;
  /** Its button in the control columns, with that button's icon and label */
  readonly button?: string;
  readonly icon?: IconName;
  readonly label?: string;
  /**
   * Whether the button shows the key alone (syncToggleButton). The heatmap's
   * also says whether a replay hides it, the altitude's whether a replay
   * colours its trail by altitude (ui/layerVisibility.ts), Share mode's
   * whether there is a selection (ui/pathSelection.ts), and the statistics
   * button is a disclosure (setupStatsRail in ui/appChrome.ts).
   */
  readonly pressed?: boolean;
  /**
   * A panel, reopened once there is data for it (MapApp.initialize), and
   * saved the way it was restored until then (StateManager.panelVisible)
   */
  readonly panel?: boolean;
  readonly sheet?: ToggleSheetRow;
}

/**
 * The toggles, in the order of their controls. The `v` slots are the order
 * of the links shared so far and must never move: slot 7 was the control
 * chrome's, which no longer hides, and is written as 0 and not read.
 */
export const TOGGLES = [
  {
    key: "heatmapVisible",
    initial: true,
    url: { slot: 0 },
    action: "toggleHeatmap",
    button: "heatmap-btn",
    icon: "heatmap",
    label: "Heatmap",
    sheet: { group: "layers", id: "heatmap" },
  },
  {
    key: "airportsVisible",
    initial: true,
    url: { slot: 3 },
    action: "toggleAirports",
    button: "airports-btn",
    icon: "airport",
    label: "Airports",
    pressed: true,
    sheet: { group: "layers", id: "airports" },
  },
  {
    key: "altitudeVisible",
    initial: false,
    url: { slot: 1 },
    action: "toggleAltitude",
    button: "altitude-btn",
    icon: "altitude",
    label: "Altitude",
    sheet: { group: "layers", id: "altitude", chip: "altitude" },
  },
  {
    key: "airspeedVisible",
    initial: false,
    url: { slot: 2 },
    action: "toggleAirspeed",
    button: "airspeed-btn",
    icon: "speed",
    // What its legend, the replay's readout and the statistics call it
    label: "Groundspeed",
    pressed: true,
    sheet: { group: "layers", id: "speed", chip: "speed" },
  },
  {
    key: "aviationVisible",
    initial: false,
    url: { slot: 4 },
    action: "toggleAviation",
    button: "aviation-btn",
    icon: "aviation",
    label: "Aviation",
    pressed: true,
    sheet: { group: "layers", id: "aviation" },
  },
  // Not layers, but how the layers are drawn, and the Layers sheet is where
  // someone looks for them. The compass floats over the map instead (see
  // MapOrientation): it has to be in reach while the map is turned.
  {
    // Whether the map is drawn as a globe rather than in Mercator
    key: "globeVisible",
    initial: false,
    url: { param: "g" },
    action: "toggleGlobe",
    button: "globe-btn",
    icon: "globe",
    label: "Globe",
    pressed: true,
    sheet: { group: "layers", id: "globe" },
  },
  {
    // Whether the flights are lifted to their altitude (calculations/lift.ts)
    key: "threeDVisible",
    initial: false,
    url: { param: "d" },
    action: "toggleThreeD",
    button: "three-d-btn",
    icon: "threeD",
    label: "3D",
    pressed: true,
    sheet: { group: "layers", id: "three-d" },
  },
  {
    // Whether the ground is drawn from satellite imagery (ui/satellite.ts)
    key: "satelliteVisible",
    initial: false,
    url: { param: "s" },
    action: "toggleSatellite",
    button: "satellite-btn",
    icon: "satellite",
    label: "Satellite",
    pressed: true,
    sheet: { group: "layers", id: "satellite" },
  },
  {
    key: "isolateSelection",
    initial: false,
    url: { slot: 8 },
    action: "toggleIsolateSelection",
    button: "isolate-btn",
    icon: "isolate",
    // Share mode (ui/pathSelection.ts); key, action, button and row keep
    // the name it had before, which links and saved states carry
    label: "Share mode",
    sheet: { group: "more", id: "isolate" },
  },
  {
    key: "statsPanelVisible",
    initial: false,
    url: { slot: 5 },
    action: "toggleStats",
    button: "stats-btn",
    icon: "stats",
    label: "Statistics",
    panel: true,
  },
  {
    // Whether the statistics rail shows its Flights tab rather than the
    // figures (ui/flightList.ts, which also runs the tabs). Every `v` slot
    // is taken, so it has a parameter of its own.
    key: "flightListVisible",
    initial: false,
    url: { param: "l" },
  },
  {
    // Wrapped's dialog, opened and closed by actions of their own
    key: "wrappedVisible",
    initial: false,
    url: { slot: 6 },
    panel: true,
  },
] as const satisfies readonly ToggleSpec[];

export type Toggle = (typeof TOGGLES)[number];
export type ToggleKey = Toggle["key"];
/** The actions that flip a toggle; ui/actions.ts must handle every one */
export type ToggleAction = Extract<Toggle, { action: string }>["action"];

/** The store value of every toggle */
export type ToggleFlags = Record<ToggleKey, boolean>;

/** Every toggle's key, in table order */
export const TOGGLE_KEYS: readonly ToggleKey[] = TOGGLES.map(
  (toggle) => toggle.key,
);

/** The value of every toggle on a first visit */
export function initialToggles(): ToggleFlags {
  return Object.fromEntries(
    TOGGLES.map((toggle) => [toggle.key, toggle.initial]),
  ) as ToggleFlags;
}

/** Length of the `v` string: every slot, the retired one included */
export const VISIBILITY_SLOTS = 9;
