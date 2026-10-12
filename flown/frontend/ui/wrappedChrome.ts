/**
 * The controls of the page while Wrapped has the map: hidden as the dialog
 * opens and put back as it closes (ui/wrappedManager.ts). Only the Wrapped
 * bundle does this, so it is kept out of utils/domCache.ts, which is part
 * of the first visit.
 */
import { domCache } from "../utils/domCache";

/**
 * Elements hidden while Wrapped has the map. The two control columns and the
 * statistics rail go as a whole, with every control, title and separator
 * inside them; the rest are panels that live outside them.
 *
 * The loading indicator is not listed: the dialog covers it anyway, and
 * restoring the display saved on opening put back a `block` that a load
 * finishing in the meantime had already cleared, stranding the indicator.
 */
export const HIDEABLE_CONTROL_IDS = [
  "left-buttons",
  "right-buttons",
  "stats-rail",
  "altitude-legend",
  "airspeed-legend",
  "heat-legend",
  "selection-chip",
] as const;

/**
 * Hide the controls that must not show while Wrapped has the map, and
 * return their inline display to put back with restoreControls
 */
export function hideControls(): Map<HTMLElement, string> {
  const savedDisplays = new Map<HTMLElement, string>();
  for (const id of HIDEABLE_CONTROL_IDS) {
    const el = domCache.get(id);
    if (el) {
      savedDisplays.set(el, el.style.display);
      el.style.display = "none";
    }
  }
  return savedDisplays;
}

export function restoreControls(savedDisplays: Map<HTMLElement, string>): void {
  savedDisplays.forEach((display, el) => {
    el.style.display = display;
  });
}
