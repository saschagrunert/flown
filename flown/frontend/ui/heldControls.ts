/**
 * The controls a mode holds while it runs: the replay of one flight, the
 * replay of all of them and the hotspot tour each take what would change
 * or take the map under them, and give it back as they end, with the focus
 * their panel had to their own control. Its own module rather than part of
 * utils/buttonState.ts, which the app reaches: only the feature bundle
 * holds controls.
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { showToast } from "../utils/toast";

/** A mode's hold: what it says, and the element that says it */
interface Hold {
  text: string;
  reason: HTMLElement;
}

/** A held control: its holds, the latest last, and what it had before */
interface Held {
  holds: Hold[];
  title: string;
  described: string | null;
  disabled: boolean;
}

/** Every held control; a control two modes hold is in it once */
const held = new Map<HTMLElement, Held>();

/** Numbers the reason elements, one per hold */
let holdCount = 0;

/** Whether `refuse` listens, which it does while any control is held */
let listening = false;

/**
 * The controls that change the selection or share mode, which a replay
 * plays and the hotspot tour tours: both hold them (see PathSelection.held)
 */
export const SELECTION_CONTROL_IDS = [
  "isolate-btn",
  "selection-clear-btn",
  "selection-share-btn",
  "selection-exit-btn",
] as const;

/**
 * Controls held by the replay of one flight and of all of them alike: the
 * filters, the selection and Wrapped would change or take the map under
 * either, and so would the other modes and the search, which moves it.
 * Each adds its own (see ui/replayManager.ts and ui/replayAll.ts).
 */
export const REPLAY_HELD_CONTROL_IDS = [
  "heatmap-btn",
  "airports-btn",
  "aviation-btn",
  "wrapped-btn",
  "year-select",
  "aircraft-select",
  ...SELECTION_CONTROL_IDS,
  "reset-view-btn",
  "cross-section-btn",
  "hotspot-tour-btn",
  "search-btn",
] as const;

/**
 * What the mode that holds `control` says, the latest of them where two
 * do; null for a control no mode holds
 */
export function heldReason(control: Element | null): string | null {
  return (
    (control && held.get(control as HTMLElement)?.holds.at(-1)?.text) ?? null
  );
}

/** Title and description of the mode that holds the control now */
function describe(control: HTMLElement, entry: Held): void {
  const hold = entry.holds.at(-1)!;
  control.title = hold.text;
  if (!(control instanceof HTMLSelectElement)) {
    control.setAttribute("aria-describedby", hold.reason.id);
  }
}

/**
 * Give a control back what it had before the first hold, or the title
 * setUnavailable gave it since
 */
function restore(control: HTMLElement, entry: Held): void {
  control.title = control.dataset["heldTitle"] ?? entry.title;
  delete control.dataset["heldTitle"];
  if (control instanceof HTMLSelectElement) {
    control.disabled = entry.disabled;
    return;
  }
  const own = control.dataset["held"];
  delete control.dataset["held"];
  if (own) control.setAttribute("aria-disabled", own);
  else control.removeAttribute("aria-disabled");
  if (entry.described === null) control.removeAttribute("aria-describedby");
  else control.setAttribute("aria-describedby", entry.described);
}

/**
 * A click on a held button says why rather than acting, ahead of every
 * listener of the page, those of the controls included
 */
function refuse(event: Event): void {
  const target = event.target;
  const control =
    target instanceof Element ? target.closest("[data-held]") : null;
  const reason = heldReason(control);
  if (reason === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  showToast(reason);
}

/** Listen for clicks on held controls while there are any */
function listen(): void {
  if (listening === held.size > 0) return;
  listening = !listening;
  if (listening) document.addEventListener("click", refuse, true);
  else document.removeEventListener("click", refuse, true);
}

/**
 * Hold the controls of `ids` for the mode `mode` ("the replay"), each
 * titled with the way to have it back, and return what gives each back as
 * it was. The hold ends as well when `signal` aborts (the app's lifetime).
 *
 * A button is held with aria-disabled, as Replay and Reset view say they
 * cannot act: it stays in the tab order, is described by the way to have
 * it back, and a click on it says that rather than acting. With the
 * disabled attribute a keyboard could not reach it, nor its title, the
 * only place that said why. Its own word (setUnavailable in
 * utils/buttonState.ts, such as the speed layer's on a site without
 * timing data) is kept in `data-held` and is what it gets back.
 *
 * A select is disabled outright: it would open its list whatever
 * aria-disabled said.
 *
 * Two modes may hold one control: it speaks for the later one, and goes
 * back to the earlier one, not free, as the later one ends.
 * @returns What releases the controls
 */
export function holdControls(
  ids: readonly string[],
  mode: string,
  signal?: AbortSignal,
): () => void {
  const reason = document.createElement("span");
  reason.id = `held-reason-${++holdCount}`;
  reason.hidden = true;
  reason.textContent = `End ${mode} to change this`;
  document.body.append(reason);
  const hold: Hold = { text: reason.textContent, reason };

  const mine: HTMLElement[] = [];
  for (const id of ids) {
    const control = domCache.get(id);
    if (
      !(control instanceof HTMLButtonElement) &&
      !(control instanceof HTMLSelectElement)
    ) {
      continue;
    }
    let entry = held.get(control);
    if (!entry) {
      entry = {
        holds: [],
        title: control.title,
        described: control.getAttribute("aria-describedby"),
        disabled: control.disabled,
      };
      held.set(control, entry);
      if (control instanceof HTMLSelectElement) {
        control.disabled = true;
      } else {
        control.dataset["held"] = control.getAttribute("aria-disabled") ?? "";
        control.setAttribute("aria-disabled", "true");
      }
    }
    entry.holds.push(hold);
    describe(control, entry);
    mine.push(control);
  }
  listen();

  const release = (): void => {
    signal?.removeEventListener("abort", release);
    if (!reason.isConnected && mine.length === 0) return;
    reason.remove();
    for (const control of mine.splice(0)) {
      const entry = held.get(control);
      if (!entry) continue;
      entry.holds = entry.holds.filter((other) => other !== hold);
      if (entry.holds.length > 0) {
        describe(control, entry);
      } else {
        held.delete(control);
        restore(control, entry);
      }
    }
    listen();
  };
  if (signal?.aborted) release();
  else signal?.addEventListener("abort", release);
  return release;
}

/**
 * Whether the focus is in `panel`, or nowhere: what a mode that ends asks
 * before its panel hides, and hands it on only then (focusModeControl).
 * Focus the user had taken elsewhere, the flight profile say, stays there.
 */
export function focusWasIn(panel: Element | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !!panel?.contains(active);
}

/**
 * Hand the focus to the control `id` of a mode that ends, whose panel had
 * it and hides: a button that hides drops its focus to <body>. On a phone
 * the control columns are hidden, and the bar's More tab, whose sheet
 * stands in for them, takes it.
 */
export function focusModeControl(app: MapApp, id: string): void {
  document
    .getElementById(app.mobileBar?.isVisible() ? "mobile-tab-more" : id)
    ?.focus();
}
