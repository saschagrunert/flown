/**
 * Work that can wait for the page to have a moment: what is got ready
 * ahead of a click (the fetch of Wrapped's code as its button is pointed
 * at, the cut of the heat cloud for its intro) and what a readout of the
 * heat cloud needs at a new zoom, none of it in the task of the event that
 * asked for it.
 */

/**
 * Longest `work` waits for the page to have a moment: a busy page runs it
 * after this many milliseconds all the same, so it is not held back for
 * long
 */
const IDLE_TIMEOUT_MS = 500;

/**
 * Run `work` in a task of its own once the page has a moment, as far as
 * the browser tells (requestIdleCallback, which Safari lacks), and not in
 * the task of the event that asked for it
 */
export function whenIdle(work: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(work, { timeout: IDLE_TIMEOUT_MS });
  } else {
    setTimeout(work, 0);
  }
}
