/**
 * Observable state store for centralized MapApp state management.
 * Provides get/set access with listener subscriptions and batched updates.
 */

import { logError } from "../utils/logger";
import type { KMLDataset } from "../types";
import type { TourView } from "../ui/hotspotTour";
import { initialToggles, TOGGLE_KEYS, type ToggleFlags } from "./toggles";

export interface Range {
  min: number;
  max: number;
  /**
   * The values at evenly spaced ranks of the data the range is of, from
   * `min` to `max`, which the colours are spread by (see scalePosition in
   * utils/colors.ts); without them they run evenly from `min` to `max`
   */
  ranks?: readonly number[];
}

/**
 * The app's state. The toggles (state/toggles.ts) are flags of the store
 * like any other; the rest follows.
 */
export interface StoreState extends ToggleFlags {
  selectedYear: string;
  selectedAircraft: string;
  selectedPathIds: ReadonlySet<number>;
  /**
   * Whether the 3D view draws the relief, and the flights stand on the
   * sampled ground (see LayerManager.syncTerrain, its only writer)
   */
  terrainActive: boolean;
  /**
   * Whether the 3D view shades the relief: where it draws it, and on the
   * globe, which leaves the relief itself out (see LayerManager.syncTerrain,
   * its only writer)
   */
  reliefShaded: boolean;
  /**
   * The whole zoom level the 3D view's relief, and the flights on it, are
   * drawn for (see reliefLevel in calculations/lift.ts): their exaggeration
   * and the ground the flights stand on. It follows the zoom where a zoom
   * ends, and only there (see LayerManager.syncTerrain, its only writer).
   */
  reliefLevel: number;
  /**
   * Whether the 3D view draws the heat as a cloud in the air, for which
   * the flat heatmap steps aside (see ui/heatCloud.ts, its only writer)
   */
  heatCloud: boolean;
  /**
   * How brightly the heat cloud draws a flight's worth of heat where the
   * map came to rest, 1 for a lone cruise at full strength, 0 without
   * points (see ui/heatCloud.ts, its only writer, and ui/heatScale.ts)
   */
  heatCloudScale: number;
  /**
   * What the flat heatmap and its lines scale their heat by (heatExposure
   * in calculations/heatExposure.ts), 1 before there is any (see
   * DataManager.followExposure, its only writer, and ui/heatScale.ts)
   */
  heatmapExposure: number;
  /**
   * Whether the heat cloud is drawn with the 3D view off as well: for
   * Wrapped's intro (ui/wrappedIntro.ts), which flies over it without
   * lifting the flights, until it settles, is skipped or the dialog
   * closes (WrappedManager.closeWrapped). Neither saved nor carried by a
   * link.
   */
  forcedHeatCloud: boolean;
  /**
   * The line of the cross-section as a link writes it, "lat,lng,lat,lng"
   * from its start to its end (see isSectionLine in state/urlState.ts),
   * "" while it shows none (see ui/crossSection.ts, its writer once the
   * saved state has been put back)
   */
  crossSectionLine: string;
  /**
   * Whether the 3D view draws the lines of a selection as ribbons at their
   * height, for which the flat lines step aside (see ui/selectionRibbons.ts,
   * its only writer)
   */
  selectionRibbons: boolean;
  /**
   * Whether the map is at a zoom the aviation chart draws at, on or off
   * (aviationDrawsAt in mapLayers.ts): the heat steps back for the chart
   * only there (see ui/layerVisibility.ts, its only writer)
   */
  aviationInView: boolean;
  /**
   * Whether a replay is running. The layer flags keep what the user chose;
   * what the map shows follows from both (see ui/layerVisibility.ts).
   */
  replayActive: boolean;
  /**
   * The user's view while the hotspot tour holds the map, null otherwise
   * (see ui/hotspotTour.ts, its only writer): the one the state manager
   * saves, as Wrapped's. Neither saved nor carried by a link.
   */
  tourView: TourView | null;
  currentData: KMLDataset | null;
  /** Whether the exported flights carry groundspeeds (metadata.json) */
  hasTimingData: boolean;
}

type Listener<T> = (newVal: T, oldVal: T) => void;

/**
 * How many rounds of listener-triggered changes one flush delivers before
 * the remaining ones are deferred to the next top-level set()
 */
const MAX_FLUSH_DEPTH = 10;

/**
 * Colour range defaults of MapApp's plain range fields; features/layers.ts
 * falls back to the same values
 */
export const DEFAULT_ALTITUDE_RANGE: Range = { min: 0, max: 10000 };
export const DEFAULT_AIRSPEED_RANGE: Range = { min: 0, max: 200 };

/**
 * Store keys that MapApp exposes as plain properties. Reading one reads the
 * store, assigning one writes it, so the managers never have to know which
 * state lives in the store and which does not.
 */
export const STORE_ACCESSOR_KEYS = [
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  ...TOGGLE_KEYS,
  "terrainActive",
  "reliefShaded",
  "reliefLevel",
  "heatCloud",
  "heatCloudScale",
  "heatmapExposure",
  "forcedHeatCloud",
  "crossSectionLine",
  "selectionRibbons",
  "aviationInView",
  "replayActive",
  "tourView",
  "currentData",
  "hasTimingData",
] as const;

export type StoreAccessorKey = (typeof STORE_ACCESSOR_KEYS)[number];

/** The accessor properties, typed exactly like the store keys they wrap */
export type StoreAccessors = Pick<StoreState, StoreAccessorKey>;

/**
 * Define a getter/setter pair per key on `target` that forwards to
 * `target.store`. Used on the MapApp prototype and on test doubles, so the
 * two cannot drift apart.
 */
export function defineStoreAccessors(
  target: { store: AppStore },
  keys: readonly StoreAccessorKey[] = STORE_ACCESSOR_KEYS,
): void {
  for (const key of keys) {
    Object.defineProperty(target, key, {
      get(this: { store: AppStore }) {
        return this.store.get(key);
      },
      set(this: { store: AppStore }, value: StoreState[typeof key]) {
        this.store.set(key, value);
      },
      enumerable: true,
      configurable: true,
    });
  }
}

/**
 * Whether a replay (of one flight or of all), the hotspot tour or Wrapped
 * holds the map, which nothing else may then move or draw on: MapApp's
 * `mapHeld`, here so that test doubles derive it the same way
 */
export function isMapHeld(store: Pick<AppStore, "get">): boolean {
  return (
    store.get("replayActive") ||
    store.get("wrappedVisible") ||
    store.get("tourView") !== null
  );
}

export function createDefaultState(): StoreState {
  return {
    selectedYear: "all",
    selectedAircraft: "all",
    selectedPathIds: new Set(),
    ...initialToggles(),
    terrainActive: false,
    reliefShaded: false,
    reliefLevel: 0,
    heatCloud: false,
    heatCloudScale: 0,
    heatmapExposure: 1,
    forcedHeatCloud: false,
    crossSectionLine: "",
    selectionRibbons: false,
    aviationInView: true,
    replayActive: false,
    tourView: null,
    currentData: null,
    hasTimingData: false,
  };
}

export class AppStore {
  private state: StoreState;
  private listeners: Map<keyof StoreState, Listener<unknown>[]>;
  private batchDepth: number;
  private pendingOldValues: Map<keyof StoreState, unknown>;
  private isNotifying: boolean;
  private flushDepth: number;
  /** subscribeKeys listeners that already ran in the current flush pass */
  private flushRan: Set<() => void> | null = null;

  constructor(initial?: Partial<StoreState>) {
    this.state = { ...createDefaultState(), ...initial };
    this.listeners = new Map();
    this.batchDepth = 0;
    this.pendingOldValues = new Map();
    this.isNotifying = false;
    this.flushDepth = 0;
  }

  get<K extends keyof StoreState>(key: K): StoreState[K] {
    return this.state[key];
  }

  set<K extends keyof StoreState>(key: K, value: StoreState[K]): void {
    const oldVal = this.state[key];
    if (oldVal === value) return;
    this.state[key] = value;
    this.settle(key);
    if (this.batchDepth > 0 || this.isNotifying) {
      if (!this.pendingOldValues.has(key)) {
        this.pendingOldValues.set(key, oldVal);
      }
    } else {
      this.notify(key, value, oldVal);
    }
  }

  /**
   * Keep what a key says of another before any listener hears of either:
   * share mode (`isolateSelection`) ends with the last flight it shares,
   * however the selection lost it. Four places ended it each, and a
   * listener that ran between a change and its end saw an empty selection
   * still shared, which left the button pressed but stuck.
   */
  private settle(key: keyof StoreState): void {
    if (key === "selectedPathIds" && this.state.selectedPathIds.size === 0) {
      this.set("isolateSelection", false);
    }
  }

  /**
   * Call `fn` on every change of `key`, until the function this returns is
   * called or `signal` aborts, whichever comes first: its owner's life
   * ends the listener without a teardown of its own. Nothing is
   * subscribed with a signal that has aborted already.
   */
  subscribe<K extends keyof StoreState>(
    key: K,
    fn: Listener<StoreState[K]>,
    { signal }: { signal?: AbortSignal } = {},
  ): () => void {
    const remove = (): void => {
      const list = this.listeners.get(key);
      if (list) {
        const idx = list.indexOf(fn as Listener<unknown>);
        if (idx >= 0) list.splice(idx, 1);
      }
    };
    if (signal?.aborted) return remove;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key)!.push(fn as Listener<unknown>);
    signal?.addEventListener("abort", remove, { once: true });
    // The abort listener goes as well: a signal that lives as long as the
    // app would otherwise hold every callback it was ever given
    return () => {
      remove();
      signal?.removeEventListener("abort", remove);
    };
  }

  /** Drop every listener; the owner is going away */
  unsubscribeAll(): void {
    this.listeners.clear();
  }

  /**
   * Call `fn` once per update that changes any of `keys`. A batch that
   * changes three of them would otherwise run it three times, each against
   * the same final state. Until `signal` aborts, as for subscribe.
   */
  subscribeKeys(
    keys: readonly (keyof StoreState)[],
    fn: () => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    const listener = (): void => {
      const ran = this.flushRan;
      if (ran) {
        if (ran.has(listener)) return;
        ran.add(listener);
      }
      fn();
    };
    const unsubscribes = keys.map((key) =>
      this.subscribe(key, listener, options),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  batch(fn: () => void): void {
    this.batchDepth++;
    try {
      fn();
    } finally {
      this.batchDepth--;
      // A batch opened by a listener leaves its changes to the flush or
      // notification that is already running
      if (this.batchDepth === 0 && this.flushDepth === 0 && !this.isNotifying) {
        this.flush();
      }
    }
  }

  private notify<K extends keyof StoreState>(
    key: K,
    newVal: StoreState[K],
    oldVal: StoreState[K],
  ): void {
    const list = this.listeners.get(key);
    if (list) {
      const wasNotifying = this.isNotifying;
      this.isNotifying = true;
      try {
        for (const fn of [...list]) {
          // A listener that throws must not keep the others, or the keys
          // still pending in this flush, from being notified
          try {
            (fn as Listener<StoreState[K]>)(newVal, oldVal);
          } catch (error) {
            logError(`Store listener for ${key} failed:`, error);
          }
        }
      } finally {
        this.isNotifying = wasNotifying;
        // A flush in progress picks up what the listeners set itself
        if (
          !this.isNotifying &&
          this.flushDepth === 0 &&
          this.pendingOldValues.size > 0
        ) {
          this.flush();
        }
      }
    }
  }

  private flush(): void {
    this.flushDepth++;
    // Pending keys are drained from the live map, so a key a listener sets
    // while the flush runs is delivered once, against the value it had before
    // the batch, instead of once by a nested flush and once more from a
    // snapshot with a stale old value. Keys set by listeners land behind the
    // ones of the batch and form the next round: subscribeKeys listeners run
    // once per round, since the state changed after their last run.
    const outerRan = this.flushRan;
    this.flushRan = new Set();
    let round = 0;
    let roundKeys = new Set(this.pendingOldValues.keys());
    try {
      while (this.pendingOldValues.size > 0) {
        const [key, oldVal] = this.pendingOldValues.entries().next().value!;
        if (!roundKeys.has(key)) {
          round++;
          if (round > MAX_FLUSH_DEPTH) {
            // Listeners this deep in each other's changes would keep the UI
            // re-entering the store instead of settling. Make the stall
            // visible instead of swallowing it; the pending entries are
            // kept, the next top-level set() flushes them.
            logError(
              `Store flush exceeded ${MAX_FLUSH_DEPTH} rounds; deferring ` +
                `updates for: ${[...this.pendingOldValues.keys()].join(", ")}`,
            );
            return;
          }
          roundKeys = new Set(this.pendingOldValues.keys());
          this.flushRan = new Set();
        }
        roundKeys.delete(key);
        this.pendingOldValues.delete(key);
        const currentVal = this.state[key];
        // A value set and set back within a batch changed nothing
        if (currentVal !== oldVal) {
          this.notify(key, currentVal, oldVal as StoreState[keyof StoreState]);
        }
      }
    } finally {
      this.flushRan = outerRan;
      this.flushDepth--;
    }
  }
}
