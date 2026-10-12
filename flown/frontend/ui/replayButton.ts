/**
 * The replay control's resting state.
 *
 * It only depends on whether the current selection could be replayed, which
 * the app knows on its own, so it lives in the main bundle: the button has
 * to explain itself from the first paint, long before anyone opens replay
 * and the feature bundle is fetched.
 */
import { setUnavailableFor } from "../utils/buttonState";
import { DAY_MAX_FLIGHTS } from "../utils/constants";
import { domCache } from "../utils/domCache";

/** Several selected flights play one after another (ui/replayManager.ts) */
export const REPLAY_BUTTON_LABEL = "Replay selected flights";
export const REPLAY_PRECONDITION_MESSAGE =
  "Pick flights with timing data to replay, under Statistics, Flights";
/**
 * Shared flights a filter hides, every one of them: share mode keeps them,
 * and the chip says "all hidden by the filter"
 */
export const REPLAY_HIDDEN_MESSAGE =
  "The shared flights are all hidden by the filter; change it to replay them";
/** More than a day of flights, such as all of an airport's (DAY_MAX_FLIGHTS) */
export const REPLAY_TOO_MANY_MESSAGE = `Select up to ${DAY_MAX_FLIGHTS} flights to replay them one after another; Replay all plays more`;

/**
 * Show whether replay is available for the current selection.
 * @param hint - Why it is not, null where it is (MapApp.replayHint)
 */
export function updateReplayButtonState(hint: string | null): void {
  const btn = domCache.get("replay-btn", HTMLButtonElement);
  if (!btn) return;

  // The button stays enabled so it can explain why replay is unavailable:
  // aria-disabled says so without taking it out of the tab order, which
  // the disabled attribute would, and the stylesheet dims it. A mode that
  // holds the button keeps its own title until it ends
  setUnavailableFor(btn, hint);
}
