/**
 * What the app and the bundle of Your flights (ui/localFlights.ts) share
 * about the flights a visitor dropped on the page: the flag that makes the
 * page start from them, the one that reopens the panel across that reload,
 * the name of the database they are kept in, and what Copy link says while
 * they are shown. Here rather than in the bundle so the app carries these
 * few bytes and not the panel.
 *
 * Every page of an origin shares one localStorage and one IndexedDB, so
 * two maps published side by side (user.github.io/a/ and /b/) would
 * otherwise start on each other's flights, and a Remove all on one would
 * take the other's files. Each name carries the page's directory, as the
 * saved state's key does (storageKey in ui/stateManager.ts); a map at the
 * root of its origin uses the bare name.
 */

/** `base`, or `base:` and the page's directory off the root */
export function keyedToPage(
  base: string,
  pathname: string = location.pathname,
): string {
  const directory = pathname.slice(0, pathname.lastIndexOf("/") + 1);
  return directory === "/" ? base : `${base}:${directory}`;
}

/**
 * The same, apart for the visitor's flights (`local`): what is kept of one
 * set of flights names none of the other's, under `base:local`. The saved
 * state (storageKey in ui/stateManager.ts) and the intros Wrapped played.
 */
export function flightsKey(
  base: string,
  local: boolean,
  pathname?: string,
): string {
  return keyedToPage(local ? `${base}:local` : base, pathname);
}

// The names below are made by calls marked pure: the build worker
// (services/localWorker.ts), which takes localCacheDbName from here, kept
// them all otherwise
/** Where the page saves its state (ui/stateManager.ts) */
export const STATE_KEY = "flown-state";
/** The state saved for the visitor's flights, which Remove all lets go */
export const LOCAL_STATE_KEY = /* @__PURE__ */ flightsKey(STATE_KEY, true);

/** Set while the page shows the visitor's flights rather than the site's */
export const LOCAL_FLIGHTS_KEY = /* @__PURE__ */ keyedToPage(
  "flown-local-flights",
);
/** Set across the reload that switches the flights, so the panel reopens */
export const REOPEN_KEY = /* @__PURE__ */ keyedToPage("flown-local-reopen");
/** The IndexedDB database of the files and the dataset (localStore.ts) */
export const LOCAL_DB_NAME = /* @__PURE__ */ keyedToPage("flown-local");
/**
 * The worker's cache directory, mounted on IndexedDB under this name
 * (services/localWorker.ts): the airport database, the elevation tiles and
 * the parsed tracks of the build, which Remove all lets go of as well. A
 * path with no slash past the first, since the mount point names the
 * database; the worker works it out from the page's directory as well.
 */
export function localCacheDbName(pathname?: string): string {
  return "/" + encodeURIComponent(keyedToPage("flown-cache", pathname));
}
export const SHARE_UNAVAILABLE_MESSAGE =
  "Links cannot carry flights that are only in this browser";

/** Whether the panel asked to be reopened after the reload */
export function wantsReopen(): boolean {
  try {
    return sessionStorage.getItem(REOPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The same, and the ask is taken: the next reload starts closed */
export function takeReopen(): boolean {
  const reopen = wantsReopen();
  if (reopen) {
    try {
      sessionStorage.removeItem(REOPEN_KEY);
    } catch {
      // Nothing to take
    }
  }
  return reopen;
}

/** Ask for the panel to be open after the reload */
export function askReopen(): void {
  try {
    sessionStorage.setItem(REOPEN_KEY, "1");
  } catch {
    // The panel then stays closed after the reload
  }
}
