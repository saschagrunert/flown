/**
 * What the panel of Your flights says (ui/localFlights.ts), and how it
 * tells the files it takes by their names: plain values and functions of
 * them, which the panel's tests check apart from the panel.
 */

import type { LocalInfo } from "../services/localStore";

export const ACCEPTED = /\.(kml|kmz)$/i;
export const AIRCRAFT_FILE = "aircraft.json";
/** The AppleDouble files macOS writes beside a file, which are no KML */
export const APPLE_DOUBLE = /^\._/;

/**
 * The name the aircraft file `number` is kept under, from 1: the store
 * keeps one file a name, and every drop may have some, one a folder.
 * aircraft.json, aircraft-2.json and on, numbered on from those kept, and
 * the build lets the highest win (flown/browser.py, input_files): the one
 * dropped last, and of a drop the one nearest the flights, as the site
 * build merges those of its directories.
 */
export function aircraftName(number: number): string {
  return number > 1 ? `aircraft-${number}.json` : AIRCRAFT_FILE;
}

/**
 * The number of the file kept under `name` if it is an aircraft file, 0
 * for a KML or KMZ file: the store keeps no other
 */
export function aircraftNumber(name: string): number {
  return ACCEPTED.test(name) ? 0 : parseInt(name.slice(9)) || 1;
}

export const SITE_FLIGHTS_MESSAGE = "Showing the site's flights";
export const UNSUPPORTED_FILES_MESSAGE =
  "Only KML and KMZ files, and an aircraft.json next to them, can be shown";
export const BUILDING_MESSAGE = "Building your flights…";
export const REBUILDING_MESSAGE =
  "The site was updated: building your flights again…";
export const BUILT_MESSAGE = "Built, opening your flights…";
export const READY_MESSAGE = "Your flights are ready";
export const LINK_OPENED_SITE_MESSAGE =
  "This link opened the site's flights, which it is of";
/**
 * Said when the browser refuses the storage: a private window, most often,
 * or site data blocked in its settings
 */
export const STORAGE_FAILED_MESSAGE =
  "This browser does not let the page keep files; leave private browsing, or allow this site to store data";
/** Said when the browser's storage for the page is full (QuotaExceededError) */
export const STORAGE_FULL_MESSAGE =
  "The browser's storage for this page is full; remove some files";
export const REMOVED_MESSAGE = "Your files are removed from this browser";
/**
 * What the files kept may come to in all: every build takes all of them,
 * and holds some copies of them while it runs
 */
export const MAX_KEPT_BYTES = 200 * 1024 * 1024;
export const TOO_LARGE_MESSAGE =
  "Your files would come to more than 200 MB; remove some first";
/**
 * The largest file the build in the browser reads (MAX_KML_BYTES in
 * flown/browser.py, which says why): a third of what the site build reads
 */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const CANCELLED_MESSAGE = "The build is stopped; your files are kept";
/** What Remove all says while it waits for the second press */
export const CONFIRM_CLEAR_LABEL = "Remove all files?";
/** Said as it asks, for a screen reader the label's change is not */
export const CONFIRM_CLEAR_MESSAGE =
  "Press Remove all again to remove all the files from this browser";
/** Said when it stops asking without the second press */
export const CONFIRM_LAPSED_MESSAGE = "Nothing was removed";

/**
 * Said in a page framed by another: Your flights does not open there (see
 * framed in ui/localFlights.ts)
 */
export const FRAMED_MESSAGE =
  "Your flights opens only on the site itself, not inside another page";

/**
 * Said of dropped files that took the place of others kept under their
 * names, which were of another size: the store keeps one file a name
 */
export function replacedMessage(names: readonly string[]): string {
  return `${names.join(", ")} replaced ${names.length === 1 ? "a file" : "files"} of the same name`;
}

/**
 * Said of files of one drop under the same name, in folders of their own:
 * the store keeps one file a name, the first
 */
export function duplicateMessage(names: readonly string[]): string {
  return `More than one file is named ${names.join(", ")}; the first is kept, rename the others`;
}

/** What each kind of LocalInfo.degraded is said as */
const DEGRADED_NAMES: Partial<Record<string, string>> = {
  airports: "the airport names",
  runways: "the runways",
  terrain: "the ground under the flights",
};

/**
 * Said of a dataset built without what the build could not fetch
 * (LocalInfo.degraded, which it sorts), with Build again beside it
 */
export function degradedMessage(degraded: readonly string[]): string {
  const missing = degraded
    .map((kind) => DEGRADED_NAMES[kind])
    .filter(Boolean)
    .join(" and ");
  return `Your flights were built without ${missing || "some of their data"}, which could not be fetched`;
}
/** What offers to build them again */
export const BUILD_AGAIN_LABEL = "Build again";

/** Said of a drop with nothing the build takes in it (a folder of others) */
export const NO_FILES_MESSAGE =
  "No KML or KMZ files were found in what was dropped";
/** Said while the folders of a drop are read */
export const READING_MESSAGE = "Reading the folders…";

/** Said of files the browser would not read (one moved since it was picked) */
export function unreadableMessage(names: readonly string[]): string {
  return `Could not read ${names.join(", ")}; pick ${names.length === 1 ? "it" : "them"} again`;
}

/** Said of files larger than the build reads (MAX_FILE_BYTES) */
export function oversizedMessage(names: readonly string[]): string {
  return `${names.join(", ")} ${names.length === 1 ? "is" : "are"} larger than ${MAX_FILE_BYTES / 1024 / 1024} MB, which the build in the browser cannot read`;
}

/** What a failure to keep something in the store is said as */
export function storageMessage(error: unknown): string {
  return error instanceof DOMException && error.name === "QuotaExceededError"
    ? STORAGE_FULL_MESSAGE
    : STORAGE_FAILED_MESSAGE;
}

/** What the panel says about what is shown */
export function shownMessage(info: LocalInfo | null | undefined): string {
  if (!info) return SITE_FLIGHTS_MESSAGE;
  // The files the flights are of: not the aircraft files, nor the ones
  // the build left out
  const left = new Set((info.skipped ?? []).map((entry) => entry.file));
  const count = info.files.filter(
    (name) => ACCEPTED.test(name) && !left.has(name),
  ).length;
  const flights = `${info.flights} flight${info.flights === 1 ? "" : "s"}`;
  const files = `${count} file${count === 1 ? "" : "s"}`;
  return `Showing your ${flights} from ${files}`;
}
