/**
 * Lazy bundles - what the app says when one cannot be fetched
 *
 * Replay, the relief, the cross-section and the hotspot tour come with the
 * feature bundle, Wrapped and the statistics panel with the Wrapped bundle,
 * the search of airports and places with the search bundle, the phone's
 * sheet and the export with the extras bundle (services/featureLoader.ts
 * fetches all four). MapApp fetches the first three the first time one of
 * their controls is used (MapApp.loadReplay, loadWrapped, loadStats,
 * toggleFeature and toggleSearch), the bar and Export the extras
 * (ui/mobileBar.ts, ui/uiToggles.ts); this module holds what those share:
 * the message each part of the app shows when its code could not be
 * loaded, `loadLazyBundle`, which shows it and takes back the one of an
 * earlier failure once a later try has worked, the fetch of the Wrapped
 * bundle ahead of a click on its button (`prepareWrappedOnIntent`), so its
 * intro is ready to play, the key that opens the search
 * (`followSearchKey`) and the parts of the lazy features each app keeps
 * (`featurePart`). It is part of the first visit, like the app: nothing
 * here may reach into the lazy bundles other than through featureLoader.
 */
import type { MapApp } from "../mapApp";
import type { FeatureModule } from "../features";
import type { CrossSectionTool } from "./crossSection";
import type { HotspotTour } from "./hotspotTour";
import type { ReplayAllControls } from "./replayAll";
import type { ReplayAllPlayer } from "./replayAllPlayer";
import {
  loadWrapped,
  noticeSiteUpdate,
  wasSiteUpdated,
} from "../services/featureLoader";
import { TRY_AGAIN } from "../services/lazyImport";
import { logError } from "../utils/logger";
import { KEYED_FIELDS } from "../utils/mapHelpers";
import { runAction } from "./actions";
import { prefersReducedMotion } from "../utils/motion";
import { dismissToast, showToast } from "../utils/toast";
import { whenIdle } from "../utils/whenIdle";

/**
 * Said when the feature bundle or the Wrapped bundle cannot be fetched.
 * Without it a click on Replay or Wrapped would do nothing at all and look
 * like a dead control; the export button says the same kind of thing when
 * html-to-image is missing.
 */
export const REPLAY_UNAVAILABLE_MESSAGE =
  "Replay is unavailable: its code could not be loaded" + TRY_AGAIN;
export const TOUR_UNAVAILABLE_MESSAGE =
  "The hotspot tour is unavailable: its code could not be loaded" + TRY_AGAIN;
export const WRAPPED_UNAVAILABLE_MESSAGE =
  "Wrapped is unavailable: its code could not be loaded" + TRY_AGAIN;
export const STATS_UNAVAILABLE_MESSAGE =
  "Statistics are unavailable: their code could not be loaded" + TRY_AGAIN;
export const CROSS_SECTION_UNAVAILABLE_MESSAGE =
  "The cross-section is unavailable: its code could not be loaded" + TRY_AGAIN;
export const SEARCH_UNAVAILABLE_MESSAGE =
  "Search is unavailable: its code could not be loaded" + TRY_AGAIN;
/** Share mode is on, but the code that frames its flights is missing */
export const SHARE_FRAME_UNAVAILABLE_MESSAGE =
  "The map could not move to the shared flights: its code could not be loaded" +
  TRY_AGAIN;

/** What a control starts in the feature bundle once it has arrived */
export type FeatureToggle = keyof Pick<
  FeatureModule,
  "toggleReplayAll" | "toggleHotspotTour" | "toggleCrossSection"
>;

/** The messages of the one file that carries Wrapped and the statistics */
export const WRAPPED_BUNDLE_MESSAGES = [
  WRAPPED_UNAVAILABLE_MESSAGE,
  STATS_UNAVAILABLE_MESSAGE,
] as const;

/**
 * The parts of the lazy features an app keeps once they are made, by name:
 * the controls of the replay of all flights, the hotspot tour, the
 * cross-section and the player of Wrapped's intro. Each listens to the map
 * and the page for as long as the app lives (its `signal`), so it is made
 * once and found again here rather than made anew on every use.
 */
interface FeatureParts {
  replayAll: ReplayAllControls;
  hotspotTour: HotspotTour;
  crossSection: CrossSectionTool;
  wrappedIntro: ReplayAllPlayer;
}

/**
 * The parts of each app. Here in the app rather than with the features:
 * the feature bundle and the Wrapped bundle both keep theirs in it, and a
 * module only the two of them used would be a chunk of its own (see
 * build.js). One feature asks for another's part by name, without
 * importing its module: the heat cloud reads the clock of the replay of
 * all flights, whose player draws the heat cloud.
 */
const featureParts = new WeakMap<object, Partial<FeatureParts>>();

/**
 * The part `key` of `app`'s features: made by `make` the first time it is
 * asked for with one, and undefined until then. An app that is destroyed
 * forgets its parts, which have let go of the page by then.
 */
export function featurePart<K extends keyof FeatureParts>(
  app: Pick<MapApp, "signal">,
  key: K,
): FeatureParts[K] | undefined;
export function featurePart<K extends keyof FeatureParts>(
  app: Pick<MapApp, "signal">,
  key: K,
  make: () => FeatureParts[K],
): FeatureParts[K];
export function featurePart<K extends keyof FeatureParts>(
  app: Pick<MapApp, "signal">,
  key: K,
  make?: () => FeatureParts[K],
): FeatureParts[K] | undefined {
  let parts = featureParts.get(app);
  if (!parts) {
    if (!make) return undefined;
    featureParts.set(app, (parts = {}));
    app.signal.addEventListener("abort", () => featureParts.delete(app), {
      once: true,
    });
  }
  let part = parts[key];
  if (!part && make) parts[key] = part = make();
  return part;
}

/**
 * A lazy bundle, or null when it could not be fetched. A failure is
 * reported here rather than at each call site, so every way into Replay,
 * Wrapped or the statistics says the same thing instead of doing nothing.
 * `messages` are those of every part of the app the file carries, which
 * stand or fall with it: one toast says it failed, the one of the part
 * that asked last.
 */
export async function loadLazyBundle<T>(
  load: () => Promise<T | null>,
  unavailable: string,
  messages: readonly string[] = [unavailable],
): Promise<T | null> {
  const bundle = await load();
  // The failure of an earlier try stays until dismissed, and would say
  // the code is unavailable over the panel it has just opened
  for (const message of messages) {
    if (bundle || message !== unavailable) dismissToast(message);
  }
  // A bundle of a newer deploy has said so (services/featureLoader.ts).
  // Any other failure after it is most likely the deploy's as well: the
  // reload it offers, said again rather than nothing, puts both right.
  if (!bundle) {
    if (wasSiteUpdated()) noticeSiteUpdate();
    else showToast(unavailable, "error");
  }
  return bundle;
}

/**
 * Get Wrapped and its intro ready while its button is pointed at or
 * focused, on either layout (see prepareWrappedIntro), once the page has
 * a moment (whenIdle) rather than in the task of the pointer's move. Not
 * under reduced motion, where no intro plays: Wrapped's code comes with
 * the click, as it always has.
 */
export function prepareWrappedOnIntent(app: MapApp): void {
  const prepare = (event: Event): void => {
    const id = (event.target as Partial<Element>).id;
    if (
      (id === "wrapped-btn" || id === "mobile-tab-wrapped") &&
      !prefersReducedMotion()
    ) {
      whenIdle(() => {
        if (app.signal.aborted) return;
        loadWrapped()
          .then((wrapped) => wrapped?.prepareWrappedIntro(app))
          .catch(logError);
      });
    }
  };
  // Neither event bubbles; both reach a listener that captures
  for (const type of ["pointerenter", "focus"]) {
    document.addEventListener(type, prepare, {
      capture: true,
      signal: app.signal,
    });
  }
}

/**
 * Open the search with `/`, as many sites do, from anywhere but a field
 * that takes text (the flight list's search, the search itself) or a
 * select (KEYED_FIELDS, the fields that keep Escape as well), and without
 * a modifier. A checkbox, a radio button or a slider takes no text: the
 * key works from a list's checkbox and a slider too. Ctrl or Alt with it is
 * the browser's or the system's. The key is the browser's quick find in
 * Firefox otherwise, which the page takes over. Not while a modal is open
 * (a sheet of the phone's bar, which a tablet with a keyboard may have, or
 * Wrapped): the search would open outside it, and one Escape close both.
 * Nor while a replay, the tour or Wrapped holds the map, which the search
 * does not open under (MapApp.toggleSearch): the key stays the browser's.
 * On an open search it goes back to the field; Escape and the button
 * close it.
 */
export function followSearchKey(app: MapApp): void {
  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.defaultPrevented ||
        app.mapHeld ||
        document.querySelector('[aria-modal="true"]:not([hidden])') ||
        (target instanceof Element && target.matches(KEYED_FIELDS))
      ) {
        return;
      }
      event.preventDefault();
      runAction(app, "openSearch");
    },
    { signal: app.signal },
  );
}
