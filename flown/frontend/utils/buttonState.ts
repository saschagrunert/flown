/**
 * Store-driven toggle button state.
 * The store is the single source of truth: a button reflects its boolean
 * store key through `aria-pressed` and the `active` class. `aria-pressed` is
 * what assistive technology reads. The stylesheet draws the pressed look
 * from the class alone, because the statistics disclosure and the mobile
 * tabs carry the class but no `aria-pressed`. Nothing here writes a style:
 * an off toggle is drawn at full strength, and only a control that cannot
 * act (`disabled`, `aria-disabled`) is dimmed, by the stylesheet.
 */
import type { AppStore, StoreState } from "../state/store";
import { domCache } from "./domCache";

/** Store keys holding a boolean value */
export type BooleanStoreKey = {
  [K in keyof StoreState]: StoreState[K] extends boolean ? K : never;
}[keyof StoreState];

/**
 * Apply a toggle state to a button element
 */
export function applyToggleButtonState(
  button: HTMLElement,
  active: boolean,
): void {
  button.setAttribute("aria-pressed", String(active));
  button.classList.toggle("active", active);
}

/**
 * Keep a toggle button in sync with a boolean store key.
 * Applies the current value immediately and on every change.
 * @returns Unsubscribe function
 */
export function syncToggleButton(
  store: AppStore,
  key: BooleanStoreKey,
  buttonId: string,
): () => void {
  const apply = (value: boolean): void => {
    const button = domCache.get(buttonId);
    if (button) applyToggleButtonState(button, value);
  };
  apply(store.get(key));
  return store.subscribe(key, (value) => apply(value));
}

/** Show or hide a colour legend via the hidden attribute, faded by CSS */
export function applyLegendVisibility(
  legend: HTMLElement,
  visible: boolean,
): void {
  legend.hidden = !visible;
}

/**
 * Keep a colour legend in step with the visibility key of its layer. The
 * stylesheet hides every legend; apart from the replay trail, which uses
 * the altitude scale with no layer on, this is what shows one.
 * @returns Unsubscribe function
 */
export function syncLegend(
  store: AppStore,
  key: BooleanStoreKey,
  legendId: string,
): () => void {
  const apply = (visible: boolean): void => {
    const legend = domCache.get(legendId);
    if (legend) applyLegendVisibility(legend, visible);
  };
  apply(store.get(key));
  return store.subscribe(key, (value) => apply(value));
}

/**
 * Say through aria-disabled whether a control can act, and with `title`
 * what it does or why it cannot: it stays in the tab order to explain
 * itself, and the stylesheet dims it. A control a mode holds (holdControls
 * in ui/heldControls.ts, which keeps the control's own word in `data-held`
 * and its title in `data-held-title`) keeps saying why it is held, and gets
 * both back as the mode ends.
 */
export function setUnavailable(
  control: HTMLElement,
  unavailable: boolean,
  title?: string,
): void {
  const held = control.dataset["held"] !== undefined;
  if (held) control.dataset["held"] = String(unavailable);
  else control.setAttribute("aria-disabled", String(unavailable));
  if (title === undefined) return;
  if (held) control.dataset["heldTitle"] = title;
  else control.title = title;
}

/**
 * setUnavailable for a control whose title, while it can act, is its
 * aria-label: `reason` says why it cannot, null that it can
 */
export function setUnavailableFor(
  control: HTMLElement,
  reason: string | null,
): void {
  setUnavailable(
    control,
    reason !== null,
    reason ?? control.getAttribute("aria-label") ?? "",
  );
}

/**
 * Set the text of a control button without touching its icon.
 * A button that carries no label span gets one: assigning `textContent`
 * would drop every child, the injected `svg.icon` included.
 */
export function setControlLabel(button: HTMLElement, text: string): void {
  const existing = button.querySelector<HTMLElement>(".control-label");
  if (existing) {
    existing.textContent = text;
    return;
  }
  // Only the bare text the span replaces goes; elements stay
  for (const node of Array.from(button.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) node.remove();
  }
  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = text;
  button.appendChild(label);
}
