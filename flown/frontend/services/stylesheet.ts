/**
 * Load the stylesheets of the lazily loaded bundles (services/featureLoader.ts)
 */
import { versioned } from "./lazyImport";

/** A stylesheet is a fraction of a year file, so it gets less time */
const STYLESHEET_TIMEOUT_MS = 30_000;

/**
 * The request per stylesheet URL, so that callers share one rather than
 * racing. Keyed on the URL as given; a failed one is dropped so the next
 * attempt starts over.
 */
const stylesheetRequests = new Map<string, Promise<void>>();

/**
 * Load a stylesheet, and leave it in the document.
 *
 * A link keeps applying only as long as it is in the head, so this one is
 * not removed once it has loaded. Callers asking for the same
 * URL share one request: dedupe on the link already being in the head was
 * wrong twice over, because a link that is still in flight had not applied
 * yet, and because the attempt that appended it removes it on its own
 * failure. A first attempt that had already been given up on could take the
 * stylesheet of a later, successful one back out of the page with it.
 *
 * @param url - URL to load
 * @returns Promise that resolves once the stylesheet applies
 */
export function loadStylesheet(url: string): Promise<void> {
  const inFlight = stylesheetRequests.get(url);
  if (inFlight) return inFlight;

  const request = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    // By the build it belongs to, like its bundle
    link.href = versioned(url);
    // Tests and debugging match on this rather than on href, which the
    // browser resolves to an absolute URL
    link.dataset["href"] = url;
    const settle = (): void => {
      clearTimeout(timer);
      link.onload = null;
      link.onerror = null;
    };
    const giveUp = (reason: string): void => {
      settle();
      link.remove();
      reject(new Error(reason + ": " + url));
    };
    link.onload = () => {
      settle();
      resolve();
    };
    link.onerror = () => giveUp("Failed to load stylesheet");
    const timer = setTimeout(
      () => giveUp("Timed out loading stylesheet"),
      STYLESHEET_TIMEOUT_MS,
    );
    document.head.appendChild(link);
  });

  stylesheetRequests.set(url, request);
  // A failure is not cached, so the next attempt tries again; the rejection
  // is handled by the caller, and this handler must not become one itself
  request.catch(() => stylesheetRequests.delete(url));
  return request;
}

/** Forget every stylesheet request (used by tests) */
export function resetStylesheetLoader(): void {
  stylesheetRequests.clear();
}
