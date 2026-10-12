import { icon } from "./icons";

/** Delay between clearing a live region and writing its new message (ms) */
export const LIVE_REGION_DELAY_MS = 100;

/** Persistent regions that speak the toasts; see map_template.html */
export const TOAST_STATUS_ID = "toast-status";
export const TOAST_ALERT_ID = "toast-alert";

/** Container the visible toasts stack in */
export const TOAST_STACK_ID = "toast-stack";

/** A write to a live region that is still to come, see announceInRegion */
interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  /**
   * The messages in the order they came. A toast stays; any other message
   * replaces the one of its kind before it.
   */
  messages: { text: string; kept: boolean }[];
}

const pendingWrites = new WeakMap<HTMLElement, PendingWrite>();

/** Messages read out as one, each a sentence of its own */
function joined(messages: string[]): string {
  if (messages.length < 2) return messages[0] ?? "";
  return messages.map((m) => (/[.!?]$/.test(m) ? m : m + ".")).join(" ");
}

/**
 * Write a message to a live region that stays in the document.
 *
 * Screen readers announce a change to a region they already track. A
 * region inserted with its text is often skipped, and so is a message
 * written in the same task the region was cleared in, so the region is
 * cleared now and filled a moment later. A newer message replaces one that
 * has not been written yet, except one that is `kept` (a toast, which
 * says what the page did on its own: an aircraft filter dropped by a
 * load that then says which year it shows). Kept messages are read out
 * with the rest in the order they came, and a text that comes twice is
 * read once.
 */
export function announceInRegion(
  region: HTMLElement,
  message: string,
  kept = false,
): void {
  const pending = pendingWrites.get(region);
  if (pending !== undefined) clearTimeout(pending.timer);
  const messages = (pending?.messages ?? []).filter((m) => kept || m.kept);
  messages.push({ text: message, kept });
  const write: PendingWrite = {
    messages,
    timer: setTimeout(() => {
      pendingWrites.delete(region);
      const texts = [...new Set(write.messages.map((m) => m.text))];
      region.textContent = joined(texts);
    }, LIVE_REGION_DELAY_MS),
  };
  region.textContent = "";
  pendingWrites.set(region, write);
}

/** The element with this id, created on the body when the page lacks it */
function ensureElement(
  id: string,
  build: (element: HTMLElement) => void,
): HTMLElement {
  const existing = document.getElementById(id);
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = id;
  build(element);
  document.body.appendChild(element);
  return element;
}

function toastRegion(type: "error" | "info"): HTMLElement {
  const alert = type === "error";
  return ensureElement(alert ? TOAST_ALERT_ID : TOAST_STATUS_ID, (region) => {
    region.className = "visually-hidden";
    region.setAttribute("role", alert ? "alert" : "status");
    region.setAttribute("aria-live", alert ? "assertive" : "polite");
    region.setAttribute("aria-atomic", "true");
  });
}

/** Speak a message through the page's status region, without a toast */
export function announceStatus(message: string): void {
  announceInRegion(toastRegion("info"), message);
}

/** A button on a toast, such as Retry after a failed load */
export interface ToastAction {
  label: string;
  /**
   * Does what the button says. False when it cannot be done now, which
   * keeps the toast: taking it away would lose the only word of what is
   * still wrong.
   */
  run: () => boolean | void;
}

/** How long an info toast stays on screen at least (ms) */
export const TOAST_DURATION_MS = 4000;

/**
 * How long one with `message` stays: the time to read it, at about a
 * dozen characters a second, where that is longer
 */
export function toastDuration(message: string): number {
  return Math.max(TOAST_DURATION_MS, message.length * 80);
}

/**
 * Take a toast off the screen. One that holds focus hands it to the map's
 * canvas, where the arrow keys move the map; on the container around it
 * they did nothing.
 */
function removeToast(toast: HTMLElement): void {
  if (toast.contains(document.activeElement)) {
    document.querySelector<HTMLElement>("#map canvas")?.focus();
  }
  toast.classList.remove("toast-visible");
  toast.addEventListener("transitionend", () => toast.remove());
  setTimeout(() => toast.remove(), 1000);
}

/** A button that does its work and then takes its toast away */
function toastButton(
  toast: HTMLElement,
  run: ToastAction["run"],
  label: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "toast-button";
  button.textContent = label;
  button.addEventListener("click", () => {
    if (run() === false) return;
    removeToast(toast);
  });
  return button;
}

/**
 * Take the toast with this message off the screen, if one is there, or
 * every error toast without one
 */
export function dismissToast(message?: string): void {
  const shown = message === undefined ? ".toast-error" : ".toast-notification";
  for (const toast of document.querySelectorAll<HTMLElement>(shown)) {
    if (message === undefined || toast.dataset["message"] === message) {
      removeToast(toast);
    }
  }
}

/**
 * Show a message. Info goes after toastDuration; an error stays until it
 * is dismissed, since it says something is wrong until someone acts on it,
 * and it can carry the action that puts it right. Info with an action stays
 * as well: a button that went away after a few seconds could not be reached
 * in time by keyboard. The same message shown again replaces the one on
 * screen rather than stacking a copy. Returns the toast, for a caller that
 * takes it away itself.
 */
export function showToast(
  message: string,
  type: "error" | "info" = "info",
  action?: ToastAction,
): HTMLElement {
  // Several toasts in a row stack in one container instead of being drawn
  // on top of each other at the same fixed position
  const stack = ensureElement(TOAST_STACK_ID, (container) => {
    container.className = "toast-stack";
  });

  const toast = document.createElement("div");
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  toast.dataset["message"] = message;
  announceInRegion(toastRegion(type), message, true);
  dismissToast(message);

  if (type === "info" && !action) {
    // The live region speaks the message; this is only its picture
    toast.setAttribute("aria-hidden", "true");
    setTimeout(() => removeToast(toast), toastDuration(message));
  } else {
    if (action) {
      toast.append(toastButton(toast, action.run, action.label));
    }
    // An icon, so the toast's text stays its message
    const dismiss = toastButton(toast, () => {}, "");
    dismiss.innerHTML = icon("close", 16);
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.title = "Dismiss";
    toast.append(dismiss);
  }

  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  return toast;
}
