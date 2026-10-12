/**
 * The safe area of the screen: how far the status bar, the Dynamic Island
 * or a notch, the rounded corners and the home indicator reach in from each
 * edge, where the map fills the screen (the home screen app on an iPhone).
 * Zero everywhere else.
 */

/** Pixels from each edge of the viewport */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

let probe: HTMLElement | undefined;
let insets: Insets | undefined;
/** Set by the app's teardown: a late frame or pan measures nothing */
let disposed = false;

const SIDES = ["Top", "Right", "Bottom", "Left"] as const;

/** Forget the insets, which a turn of the phone changes */
function forget(): void {
  insets = undefined;
}

/**
 * The insets of the safe area. Only a stylesheet can read env(), and a
 * custom property hands it on unresolved, so a hidden element takes the
 * insets as its padding and is measured: once, until the window changes
 * size or turns. Where env() is unknown the padding is dropped, and all are 0.
 */
export function safeAreaInsets(): Insets {
  if (disposed) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (!insets) {
    if (!probe) {
      probe = document.body.appendChild(document.createElement("div"));
      probe.id = "safe-area-probe";
      probe.style.cssText = `position:fixed;visibility:hidden;padding:${SIDES.map((side) => `env(safe-area-inset-${side.toLowerCase()})`).join(" ")}`;
      addEventListener("resize", forget);
      addEventListener("orientationchange", forget);
    }
    const style = getComputedStyle(probe);
    const [top, right, bottom, left] = SIDES.map(
      (side) => parseFloat(style[`padding${side}`]) || 0,
    ) as [number, number, number, number];
    insets = { top, right, bottom, left };
  }
  return insets;
}

/**
 * Drop the probe and what was measured. With `dispose` (the app's
 * teardown) nothing is measured again, so a frame or a pan scheduled
 * before it does not put the probe and its listeners back; a new app
 * starts measuring again.
 */
export function resetSafeArea(dispose = false): void {
  disposed = dispose;
  probe?.remove();
  probe = insets = undefined;
  removeEventListener("resize", forget);
  removeEventListener("orientationchange", forget);
}
