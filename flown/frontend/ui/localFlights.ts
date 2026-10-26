/**
 * Your flights: the panel that takes the KML files a visitor drops on the
 * page, builds them in the browser and shows them in place of the site's.
 *
 * The files go into the browser's storage (services/localStore.ts), a
 * worker running the site's own Python builds the data files of a site
 * from them (services/localBuild.ts), and those go into the storage too.
 * The page then reloads with a flag set (LOCAL_FLIGHTS_KEY), and starts
 * from that dataset instead of the site's (localStartConfig, which
 * mapApp.ts asks for at start): everything the map does, the filters, the
 * statistics, the replays and Wrapped, works on those flights as it does
 * on the site's, and nothing leaves the browser. The panel says which
 * flights are shown, and switches back to the site's without losing the
 * files; Remove all lets them go.
 *
 * The panel stands beside its button in the left column where the columns
 * are shown, and spans the top of the map on a phone, as the search does
 * (local.css). Files dropped anywhere on the page land here as well
 * (ui/fileDrop.ts, which is in the app and brings this bundle in).
 */

import type { MapApp, MapConfig } from "../mapApp";
import { LocalBuilder, type InputFile } from "../services/localBuild";
import {
  CACHE_BUSY_MESSAGE,
  CACHE_GONE_MESSAGE,
  clearAll,
  deleteCache,
  fileStamp,
  listFiles,
  putDataset,
  putFiles,
  readDatasetFile,
  readFileBytes,
  readInfo,
  removeFile,
  requestPersistence,
  type LocalInfo,
  type StoredFile,
  type StoredFileWithBytes,
} from "../services/localStore";
import { siteData } from "../state/siteData";
import { setUnavailable } from "../utils/buttonState";
import { escapeHtml } from "../utils/escape";
import { formatFileSize } from "../utils/formatters";
import { icon } from "../utils/icons";
import { FIELDS, isPageEscape } from "../utils/mapHelpers";
import { logError } from "../utils/logger";
import { storedFlag, storeFlag } from "../utils/storedFlag";
import { showToast } from "../utils/toast";
import {
  askReopen,
  keyedToPage,
  LOCAL_FLIGHTS_KEY,
  LOCAL_STATE_KEY,
  SHARE_UNAVAILABLE_MESSAGE,
  takeReopen,
} from "../state/localFlags";
import { trustedHtml } from "../utils/trustedHtml";
import { droppedOf } from "./fileDropWatch";
import { DROP_IN_WRAPPED_MESSAGE } from "./fileDrop";
import {
  ACCEPTED,
  AIRCRAFT_FILE,
  APPLE_DOUBLE,
  aircraftName,
  aircraftNumber,
  BUILD_AGAIN_LABEL,
  BUILDING_MESSAGE,
  BUILT_MESSAGE,
  CANCELLED_MESSAGE,
  CONFIRM_CLEAR_LABEL,
  CONFIRM_CLEAR_MESSAGE,
  CONFIRM_LAPSED_MESSAGE,
  degradedMessage,
  duplicateMessage,
  FRAMED_MESSAGE,
  LINK_OPENED_SITE_MESSAGE,
  MAX_FILE_BYTES,
  MAX_KEPT_BYTES,
  NO_FILES_MESSAGE,
  oversizedMessage,
  READING_MESSAGE,
  READY_MESSAGE,
  REBUILDING_MESSAGE,
  REMOVED_MESSAGE,
  replacedMessage,
  shownMessage,
  STORAGE_FAILED_MESSAGE,
  storageMessage,
  TOO_LARGE_MESSAGE,
  unreadableMessage,
  UNSUPPORTED_FILES_MESSAGE,
} from "./localMessages";

/** The button in the left column, and the row of the phone's More sheet */
export const LOCAL_BUTTON_ID = "local-flights-btn";
export const LOCAL_PANEL_ID = "local-flights";
/** The data directory of the dataset: what the loader asks for under it */
export const LOCAL_DATA_DIR = "local";
/** Pixels between the button and the panel beside it */
const PANEL_GAP_PX = 8;

/** How a file is named for its aircraft, which the hint links to */
const NAMING_DOCS_URL =
  "https://github.com/saschagrunert/flown/blob/main/doc/usage.md#kml-file-naming-convention";
/** The controls that copy a link to the site (ui/uiToggles.ts, shareLink) */
const SHARE_CONTROL_IDS = ["share-btn", "selection-link-btn"];

/** Set while the visitor asked for their flights without the ground */
export const NO_TERRAIN_KEY = keyedToPage("flown-local-no-terrain");
/**
 * The visitor's choice of the ground where the browser would not keep it
 * (its storage full or refused): for the page's lifetime, as storeFlag says
 */
let unkeptNoTerrain: boolean | undefined;

/** Whether the flights are asked for without the ground, in any tab */
function noTerrain(): boolean {
  return unkeptNoTerrain ?? storedFlag(NO_TERRAIN_KEY);
}

/** Keep the choice of the ground, for every tab, or for this one alone */
function keepNoTerrain(on: boolean): void {
  storeFlag(NO_TERRAIN_KEY, on);
  unkeptNoTerrain = storedFlag(NO_TERRAIN_KEY) === on ? undefined : on;
}
/**
 * Written by a Remove all, for the other tabs that show the flights it
 * removed (reopenAfterSwitch): they would save their view of them again
 */
export const REMOVED_KEY = keyedToPage("flown-local-removed");
/**
 * Set in a tab once it started on the visitor's flights: a state in its
 * address is of its own history there, not a link opened on it (see
 * localStartConfig; the page writes none while it shows them)
 */
export const OWN_TAB_KEY = keyedToPage("flown-local-tab");

/**
 * How long Remove all waits for its second press (CONFIRM_CLEAR_LABEL), at
 * the least, and on while the button has the focus (askToClear): time
 * enough to hear the question out and find the button again (WCAG 2.2.1)
 */
export const CONFIRM_CLEAR_MS = 15_000;
/** A later click this soon after the first is of a triple-click, at the
 * 500 ms double-click time of most systems */
const DOUBLE_CLICK_MS = 500;

/**
 * Whether another page frames this one. Your flights is the one state of
 * the site such a page could act on, with clicks it lures onto the frame
 * (a meta CSP sets no frame-ancestors, and GitHub Pages sends none): a
 * Remove all of the visitor's files, a build of them. So in a frame the
 * page starts on the site's flights, and the panel does not open.
 */
function framed(): boolean {
  return window.parent !== window;
}

/** Set in a tab once its start said so: once a tab, not at every reload */
const DEGRADED_SAID_KEY = keyedToPage("flown-local-degraded-said");

/** What a drop hands over: files, and folders by their entries (dropped) */
export type Dropped = FileList | readonly (File | FileSystemEntry)[];

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** The entries of a folder, read in the parts the browser hands out */
async function entriesOf(
  folder: FileSystemDirectoryEntry,
): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const part = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!part.length) return entries;
    entries.push(...part);
  }
}

/**
 * The files before the folders: an aircraft.json in a folder comes after
 * the one around it, and wins over it (aircraftName)
 */
const foldersLast = (
  a: File | FileSystemEntry,
  b: File | FileSystemEntry,
): number =>
  +!!(a as FileSystemEntry).isDirectory - +!!(b as FileSystemEntry).isDirectory;

/**
 * The files of a drop: those dropped, and those in the folders dropped,
 * however deep, each folder's before those of the folders in it. Of a
 * folder only what the build takes: it holds other files too, which are
 * no mistake of the visitor's, and not its .git, which holds no flights
 * and thousands of objects (the site build leaves it out too,
 * validation.list_kml_files). What could not be read is named in
 * `unreadable`.
 */
async function filesOf(
  dropped: Dropped,
  unreadable: string[],
): Promise<File[]> {
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry, top: boolean): Promise<void> => {
    try {
      if (entry.isDirectory) {
        if (!top && entry.name === ".git") return;
        const entries = await entriesOf(entry as FileSystemDirectoryEntry);
        for (const inner of entries.sort(foldersLast)) await walk(inner, false);
      } else if (
        top ||
        ACCEPTED.test(entry.name) ||
        entry.name === AIRCRAFT_FILE
      ) {
        files.push(await fileOf(entry as FileSystemFileEntry));
      }
    } catch (error) {
      logError(`Could not read ${entry.name}:`, error);
      unreadable.push(entry.name);
    }
  };
  for (const item of Array.from(dropped).sort(foldersLast)) {
    if ("isDirectory" in item) await walk(item, true);
    else files.push(item);
  }
  return files;
}

/**
 * The aircraft file kept that `file` is, dropped again: of the same bytes,
 * not only of the same size, which one with a model renamed has as well
 */
async function keptAs(
  file: File,
  names: Iterable<string>,
): Promise<string | undefined> {
  try {
    const text = await file.text();
    for (const name of names) {
      const kept = aircraftNumber(name) && (await readFileBytes(name));
      if (kept && decode(kept) === text) return name;
    }
  } catch {
    // Taken for another: one that cannot be read is said so as it is kept
  }
  return undefined;
}

/** The build of the page's frontend, which a dataset of another is not read by */
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/**
 * The build of the site: its frontend, and its generator, which covers the
 * Python that builds the dataset (MapConfig.generator). A deploy that
 * changes either builds the flights again, and fetches that Python anew.
 */
export function siteBuild(
  config: Pick<MapConfig, "generator">,
): string | undefined {
  return config.generator ? `${BUILD ?? ""}:${config.generator}` : BUILD;
}

/**
 * Whether the dataset was built from exactly the files kept, by this build
 * of the site (another's may write the year files in another format), and
 * with or without the ground as asked for now
 */
export function upToDate(
  info: LocalInfo | null,
  files: StoredFile[],
  config: Pick<MapConfig, "generator"> = window.MAP_CONFIG ?? {},
): boolean {
  return (
    !!info &&
    info.build === siteBuild(config) &&
    info.stamp === fileStamp(files) &&
    (info.terrain !== false) === !noTerrain()
  );
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Whether an element is rendered, and so can take focus; taken for shown
 * where the browser cannot tell (checkVisibility is recent)
 */
function rendered(element: HTMLElement): boolean {
  return (
    typeof element.checkVisibility !== "function" || element.checkVisibility()
  );
}

/** Whether the start said in this tab already what the dataset lacks */
function saidThisTab(): boolean {
  try {
    if (sessionStorage.getItem(DEGRADED_SAID_KEY) === "1") return true;
    sessionStorage.setItem(DEGRADED_SAID_KEY, "1");
  } catch {
    // Said at every start, then
  }
  return false;
}

function ownTab(): boolean {
  try {
    return sessionStorage.getItem(OWN_TAB_KEY) === "1";
  } catch {
    return false;
  }
}

function markOwnTab(): void {
  try {
    sessionStorage.setItem(OWN_TAB_KEY, "1");
  } catch {
    // A link in the address bar then opens on the site's flights
  }
}

/**
 * Set by a start whose dataset is not of the files kept or of this deploy,
 * to what the panel says as it builds them again
 */
let staleAtStart: string | null = null;
/** The app the page started (reopenAfterSwitch), whose save a reload drops */
let started: MapApp | null = null;
/** Set by a start on a link of the site's flights, with the flag set */
let linkedAway = false;

/**
 * The configuration of a page that starts from the dataset in the
 * browser, or null when there is none (the flag is then cleared, and the
 * page starts from the site's flights as it would without it).
 *
 * Two starts go to the site's flights and keep the flag. One with a state
 * in its address that this tab did not write: a link someone copied, from
 * before the share token or from an address bar, is of the site's flights
 * (as mapApp.ts takes a shared link), and would pick its year, aircraft
 * and ids out of the visitor's. And one whose dataset another deploy of
 * the site built, which may write the year files in another format: the
 * panel opens and builds the files again (reopenAfterSwitch), rather than
 * the visitor finding the site's flights without a word.
 */
export async function localStartConfig(
  config: MapConfig,
  // The page's address without a query, as the panel reloads: the state in
  // it is of the dataset the page goes from. And without the save of that
  // state as the page goes, which put it back for the dataset built (the
  // app's from the start: a year file read while it starts may reload)
  reload: () => void = () => {
    (started ?? window.mapApp)?.stateManager?.cancelSave();
    location.replace(location.pathname);
  },
): Promise<MapConfig | null> {
  // The flag is kept for the visitor's next visit to the site itself
  if (framed()) return null;
  if (location.search && !ownTab()) {
    linkedAway = true;
    return null;
  }
  const giveUp = (): null => {
    storeFlag(LOCAL_FLIGHTS_KEY, false);
    return null;
  };
  let info: LocalInfo | null;
  let files: StoredFile[];
  try {
    [info, files] = await Promise.all([readInfo(), listFiles()]);
  } catch (error) {
    logError("Could not read the flights kept in this browser:", error);
    return giveUp();
  }
  if (!info || !files.length) {
    // Removed in another tab, which may have shown them on and saved its
    // view of them again (forgetLocalState)
    try {
      localStorage.removeItem(LOCAL_STATE_KEY);
    } catch {
      // Nothing was kept
    }
    return giveUp();
  }
  // Of other files than the ones kept (a file removed while the rebuild
  // failed) as well: built again as the panel opens
  if (!upToDate(info, files, config)) {
    // Said to be an update of the site only where another deploy built
    // it; otherwise a stopped build of a drop left it behind
    staleAtStart =
      info.build === siteBuild(config) ? BUILDING_MESSAGE : REBUILDING_MESSAGE;
    return null;
  }
  markOwnTab();
  const prefix = `${LOCAL_DATA_DIR}/`;
  const bytesOf = async (url: string): Promise<ArrayBuffer> => {
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    const [bytes, now] = await Promise.all([readDatasetFile(path), readInfo()]);
    // Built again since the page started, which says so with a toast and
    // goes on (LocalFlights.build): a year file of the new dataset is of
    // other flights than the page's metadata, so the page goes to it
    // whole rather than mix the two
    if (now?.builtAt !== info.builtAt) {
      reload();
      return new Promise<never>(() => {});
    }
    if (!bytes) throw new Error(`Not in this browser: ${url}`);
    return bytes;
  };
  return {
    ...config,
    bounds: info.bounds,
    dataDir: LOCAL_DATA_DIR,
    dataSource: {
      fetchJson: async (url): Promise<unknown> =>
        JSON.parse(decode(await bytesOf(url))),
      fetchBytes: bytesOf,
    },
    localFlights: info,
  };
}

/**
 * The country codes the site has a flag for (its metadata.json): the build
 * in the worker has the package, not the flags, which the page serves.
 * Those the page loaded, where it shows the site's flights; fetched as the
 * site's build otherwise.
 */
async function siteFlags(
  app: MapApp,
  config: MapConfig,
): Promise<string[] | undefined> {
  const loaded = app.config.localFlights
    ? undefined
    : siteData.metadata?.available_flags;
  if (loaded) return loaded;
  try {
    const build = siteBuild(config);
    const response = await fetch(
      `${config.dataDir}/metadata.json` +
        (build ? `?v=${encodeURIComponent(build)}` : ""),
    );
    const metadata = (await response.json()) as { available_flags?: unknown };
    const flags = metadata.available_flags;
    return Array.isArray(flags)
      ? flags.filter((flag): flag is string => typeof flag === "string")
      : undefined;
  } catch {
    // Codes instead of flags
    return undefined;
  }
}

/**
 * The panel's actions, by their data-local, with their labels; which are
 * shown the panel decides as it draws (draw), from the start
 */
const ACTIONS = {
  show: "Show my flights",
  again: BUILD_AGAIN_LABEL,
  cancel: "Stop the build",
  site: "Show the site’s flights",
  clear: "Remove all",
};
type Action = keyof typeof ACTIONS;

const PANEL_HTML =
  '<div class="local-flights-head">' +
  `<h2 class="local-flights-title" id="${LOCAL_PANEL_ID}-title">` +
  icon("upload", 16) +
  "Your flights</h2>" +
  '<button type="button" class="local-flights-close" ' +
  'title="Close" aria-label="Close your flights">' +
  icon("close", 16) +
  "</button></div>" +
  '<p class="local-flights-shown"></p>' +
  '<label class="local-flights-drop">' +
  icon("upload", 20) +
  '<span class="local-flights-drop-text">Drop KML or KMZ files here, or ' +
  "<span class='local-flights-choose'>choose files</span></span>" +
  '<span class="local-flights-drop-touch">Choose KML or KMZ files</span>' +
  // The types too: the iOS picker greys out a file by its type, which an
  // extension alone may not give it
  '<input type="file" multiple accept=".kml,.kmz,.json,' +
  "application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz," +
  'application/json" ' +
  'aria-label="Choose the KML or KMZ files of your flights"></label>' +
  '<p class="local-flights-hint">The aircraft comes from each file’s name, ' +
  "such as 1_DEAGJ_DA20.kml " +
  `(<a href="${NAMING_DOCS_URL}" target="_blank" rel="noopener">how to ` +
  "name them</a>), and the year from the times in it; add an aircraft.json " +
  "for the model names. Folders too, up to 200 MB in all, 32 MB a file.</p>" +
  '<ul class="local-flights-files" aria-label="Your files"></ul>' +
  '<ul class="local-flights-warnings" aria-label="What the build said" hidden></ul>' +
  '<p class="local-flights-status" role="status"></p>' +
  '<p class="local-flights-status is-error" role="alert"></p>' +
  '<label class="local-flights-terrain"><input type="checkbox"> ' +
  "Without the ground under the flights</label>" +
  '<div class="local-flights-actions">' +
  Object.entries(ACTIONS)
    .map(
      ([action, label]) =>
        `<button type="button" class="btn-surface" data-local="${action}">${label}</button>`,
    )
    .join("") +
  "</div>" +
  '<p class="local-flights-note">The files and the map built from them are ' +
  "kept in this browser’s storage, and the files never leave it. The build " +
  "fetches its Python runtime from a CDN and the airport names from " +
  "OurAirports. For the ground under the flights it fetches the elevation " +
  "tiles they cross from AWS, which tells AWS roughly where you flew; " +
  "without the ground, it fetches none.</p>";

export class LocalFlights {
  readonly panel: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly list: HTMLElement;
  private readonly warnings: HTMLElement;
  private readonly status: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly terrainOff: HTMLInputElement;
  private readonly actions: Record<Action, HTMLButtonElement>;
  private files: StoredFile[] = [];
  private info: LocalInfo | null;
  private building = false;
  /** Set while the dataset a build made is being kept: too late to stop */
  private keeping = false;
  /** Whether the build on its way samples the ground, fetching its tiles */
  private buildsGround = false;
  private buildAgain = false;
  /** Whether the next build downloads again what the last could not */
  private retry = false;
  /**
   * Whether a build asked for since the last one ended goes on to show the
   * flights: a drop and Show my flights do, a removal or the ground asked
   * for otherwise only where the visitor's flights are shown already
   */
  private reveal = false;
  /** The wait for the second press of Remove all, while there is one */
  private confirming: ReturnType<typeof setTimeout> | undefined;
  /** When Remove all began to ask (Date.now()) */
  private askedAt = 0;
  /** Counts up as files go, so a build of files since removed is dropped */
  private generation = 0;
  /**
   * Counts the builds started, and each Remove all, which lets go of the
   * one running: a build let go of leaves the panel, and `building`, to
   * what came since
   */
  private run = 0;
  /**
   * The Remove all on its way, settled either way: what it clears takes
   * a while (the cache waits on another tab), and files kept or built
   * meanwhile would go with it, or come back as the flights it removed
   */
  private clearing: Promise<unknown> = Promise.resolve();
  /**
   * The drops being kept, one after the other: each checks what is kept
   * already against the cap (MAX_KEPT_BYTES), which two at once would
   * each pass alone
   */
  private adding: Promise<unknown> = Promise.resolve();
  private opener: HTMLElement | null = null;
  private readonly lifetime = new AbortController();

  constructor(
    readonly app: MapApp,
    private readonly builder = new LocalBuilder(),
    // The page's address without a query: the state in it (the year, the
    // selection) is of the flights it showed, which the next are not
    private readonly reload: () => void = () =>
      location.replace(location.pathname),
  ) {
    this.info = app.config.localFlights ?? null;
    const panel = document.createElement("div");
    panel.id = LOCAL_PANEL_ID;
    panel.className = "local-flights";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", `${LOCAL_PANEL_ID}-title`);
    panel.hidden = true;
    panel.innerHTML = trustedHtml(PANEL_HTML);
    this.panel = panel;
    this.shown = panel.querySelector(".local-flights-shown")!;
    this.list = panel.querySelector(".local-flights-files")!;
    this.warnings = panel.querySelector(".local-flights-warnings")!;
    this.status = panel.querySelector('.local-flights-status[role="status"]')!;
    this.alert = panel.querySelector('.local-flights-status[role="alert"]')!;
    this.input = panel.querySelector(".local-flights-drop input")!;
    this.terrainOff = panel.querySelector(".local-flights-terrain input")!;
    this.terrainOff.checked = noTerrain();
    this.actions = Object.fromEntries(
      Object.keys(ACTIONS).map((action) => [
        action,
        panel.querySelector(`[data-local="${action}"]`),
      ]),
    ) as Record<Action, HTMLButtonElement>;
    // Ahead of the map, as the controls are (see locationSearch.ts)
    const home = document.getElementById("map")?.closest("main");
    if (home) home.before(panel);
    else document.body.append(panel);
    document
      .getElementById(LOCAL_BUTTON_ID)
      ?.setAttribute("aria-controls", LOCAL_PANEL_ID);

    const signal = this.lifetime.signal;
    const listen = { signal };
    panel
      .querySelector(".local-flights-close")!
      .addEventListener("click", () => this.close(), listen);
    this.input.addEventListener(
      "change",
      () => {
        // A copy: the list is live, and clearing the field empties it
        const picked = Array.from(this.input.files ?? []);
        this.input.value = "";
        if (picked.length) void this.add(picked);
      },
      listen,
    );
    this.terrainOff.addEventListener(
      "change",
      () => {
        keepNoTerrain(this.terrainOff.checked);
        this.clearAlert();
        this.groundAsked(true);
      },
      listen,
    );
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key === NO_TERRAIN_KEY) this.groundAsked(false);
      },
      listen,
    );
    const drop = panel.querySelector<HTMLElement>(".local-flights-drop")!;
    drop.addEventListener(
      "dragover",
      (event) => {
        event.preventDefault();
        drop.classList.add("is-over");
      },
      listen,
    );
    drop.addEventListener(
      "dragleave",
      () => drop.classList.remove("is-over"),
      listen,
    );
    drop.addEventListener(
      "drop",
      (event) => {
        // Taken here, which the window's drop sees and leaves alone
        // (ui/fileDropWatch.ts); it still goes up, so the sheet over the
        // map hides on it (ui/fileDrop.ts)
        event.preventDefault();
        drop.classList.remove("is-over");
        const files = event.dataTransfer && droppedOf(event.dataTransfer);
        if (files?.length) void this.add(files);
      },
      listen,
    );
    this.list.addEventListener(
      "click",
      (event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-remove]")
            : null;
        if (button) void this.remove(button.dataset["remove"]!);
      },
      listen,
    );
    this.actions.show.addEventListener("click", () => void this.show(), listen);
    this.actions.again.addEventListener(
      "click",
      () => void this.buildAgainNow(),
      listen,
    );
    this.actions.cancel.addEventListener("click", () => this.cancel(), listen);
    this.actions.site.addEventListener("click", () => this.showSite(), listen);
    // Twice: once, and again while it asks (CONFIRM_CLEAR_LABEL), since
    // it lets go of everything, a long build among it, with no way back
    this.actions.clear.addEventListener(
      "click",
      (event) => {
        // Not the second click of a double-click, however slow, which is
        // one press, nor the clicks of a triple-click right after; a press
        // of its own after a pause, however quick the clicks, confirms
        if (
          this.confirming !== undefined &&
          (event.detail === 2 ||
            (event.detail > 2 && Date.now() - this.askedAt < DOUBLE_CLICK_MS))
        ) {
          return;
        }
        if (this.confirming === undefined) this.askToClear();
        else void this.clear();
      },
      listen,
    );
    // The page's Escape, after whatever is open inside it took its own
    // (doc/features.md, "Keyboard"): wherever the focus is, but not in a
    // text field of the page, whose Escape is its own
    document.addEventListener(
      "keydown",
      (event) => {
        const inside =
          event.target instanceof Node && panel.contains(event.target);
        if (this.isOpen() && isPageEscape(event, inside ? "" : FIELDS)) {
          event.preventDefault();
          this.close();
        }
      },
      listen,
    );
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (
          !panel.hidden &&
          target instanceof Node &&
          !panel.contains(target) &&
          !(target instanceof Element && target.closest(`#${LOCAL_BUTTON_ID}`))
        ) {
          this.close(false);
        }
      },
      { capture: true, signal },
    );
    window.addEventListener("resize", () => this.place(), listen);
    app.store.subscribe(
      "statsPanelVisible",
      () => requestAnimationFrame(() => this.place()),
      listen,
    );
    app.signal.addEventListener("abort", () => this.destroy(), listen);
    this.render();
  }

  isOpen(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    const focused = document.activeElement;
    this.opener =
      focused instanceof HTMLElement && focused !== document.body
        ? focused
        : null;
    this.panel.hidden = false;
    this.setButtonExpanded(true);
    this.place();
    this.panel.querySelector<HTMLElement>(".local-flights-close")?.focus();
    void this.refresh();
  }

  close(restoreFocus = true): void {
    if (this.panel.hidden) return;
    // Opened again, one press would remove everything
    this.stopAsking();
    const focused = this.panel.contains(document.activeElement);
    this.panel.hidden = true;
    this.setButtonExpanded(false);
    if (restoreFocus && focused) {
      // The first of them that is shown: on a phone the column with the
      // button is hidden, and so is an opener in it (a reopen, a drop)
      [
        this.opener,
        document.getElementById(LOCAL_BUTTON_ID),
        document.getElementById("mobile-tab-more"),
        this.app.map?.getCanvas(),
      ]
        .find((element) => element?.isConnected && rendered(element))
        ?.focus();
    }
  }

  destroy(): void {
    this.lifetime.abort();
    this.stopAsking();
    // A build on its way is let go of, as a stop lets go of one: nothing it
    // ends with is said, kept or shown, and none queued after it starts
    this.run++;
    this.building = false;
    this.buildAgain = false;
    this.reveal = false;
    this.panel.hidden = true;
    this.builder.destroy();
    this.panel.remove();
    this.setButtonExpanded(false);
    if (current === this) current = null;
  }

  /** Beside the button where it is shown, at the top otherwise */
  private place(): void {
    if (!this.isOpen()) return;
    const button = document.getElementById(LOCAL_BUTTON_ID);
    const box = button?.getBoundingClientRect();
    const anchored = !!box && box.width > 0 && !button!.closest("[hidden]");
    this.panel.classList.toggle("is-anchored", anchored);
    if (anchored) {
      this.panel.style.setProperty(
        "--local-left",
        `${Math.round(box.right + PANEL_GAP_PX)}px`,
      );
      this.panel.style.setProperty("--local-top", `${Math.round(box.top)}px`);
    }
  }

  private setButtonExpanded(expanded: boolean): void {
    const button = document.getElementById(LOCAL_BUTTON_ID);
    button?.setAttribute("aria-expanded", String(expanded));
    button?.classList.toggle(
      "active",
      expanded || !!this.app.config.localFlights,
    );
  }

  /**
   * The files kept, read again, and whether the ground is asked for: another
   * tab may have changed them
   */
  private async refresh(): Promise<void> {
    this.terrainOff.checked = noTerrain();
    try {
      [this.files, this.info] = await Promise.all([listFiles(), readInfo()]);
    } catch (error) {
      logError("Could not read the files kept in this browser:", error);
      this.say(STORAGE_FAILED_MESSAGE, true);
      return;
    }
    this.render();
  }

  private render(): void {
    // A control with the focus that the redraw removes or hides would drop
    // it to the page, and the next Tab would start there again
    const focused = document.activeElement;
    const had =
      focused instanceof HTMLElement && this.panel.contains(focused)
        ? focused
        : null;
    const removes = (): HTMLElement[] =>
      Array.from(this.list.querySelectorAll<HTMLElement>("[data-remove]"));
    const removeIndex = had ? removes().indexOf(had) : -1;
    this.draw();
    if (!had || (had.isConnected && !had.closest("[hidden]"))) return;
    const left = removes();
    // The Remove that took its place, an action still there (Stop the
    // build, for Show my flights), the files' field, Close
    [
      left[Math.min(removeIndex, left.length - 1)],
      ...Object.values(this.actions),
      this.input,
      this.panel.querySelector<HTMLElement>(".local-flights-close"),
    ]
      .find((control) => control && !control.closest("[hidden]"))
      ?.focus();
  }

  private draw(): void {
    const local = !!this.app.config.localFlights;
    this.shown.textContent = shownMessage(this.app.config.localFlights);
    // The files the last build left out, marked with the reason
    const skipped = new Map(
      (this.info?.skipped ?? []).map((entry) => [entry.file, entry.reason]),
    );
    this.list.innerHTML = trustedHtml(
      this.files
        .map((file) => {
          const reason = skipped.get(file.name);
          return (
            `<li${reason ? ' class="is-skipped"' : ""}>` +
            `<span class="local-flights-name">${escapeHtml(file.name)}</span>` +
            `<span class="local-flights-size">${formatFileSize(file.size)}</span>` +
            `<button type="button" class="local-flights-remove" data-remove="${escapeHtml(file.name)}" ` +
            `title="Remove ${escapeHtml(file.name)}" aria-label="Remove ${escapeHtml(file.name)}">` +
            icon("close", 16) +
            "</button>" +
            (reason
              ? `<span class="local-flights-reason">Left out: ${escapeHtml(reason)}</span>`
              : "") +
            "</li>"
          );
        })
        .join(""),
    );
    const warnings = this.files.length ? (this.info?.warnings ?? []) : [];
    this.warnings.innerHTML = trustedHtml(
      warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join(""),
    );
    this.warnings.hidden = !warnings.length;
    const any = this.files.length > 0;
    // Show my flights: the dataset is there and the page shows the site's,
    // or the visitor's are shown but not of the files kept (a build of a
    // drop was stopped) or not the latest (one built while the panel was
    // closed, said only by a toast); a changed set of files is built again
    // as it is shown
    this.actions.show.hidden = !any || this.showsKept() || this.building;
    // A dataset built without what could not be fetched (offline), which
    // a build tries again: offered, rather than built again at every
    // start, which offline would do over and over
    const degraded =
      upToDate(this.info, this.files) && !!this.info?.degraded?.length;
    this.actions.again.hidden = !any || !degraded || this.building;
    this.actions.again.title = degraded
      ? degradedMessage(this.info?.degraded ?? [])
      : "";
    // Not once the build is done and its dataset is being kept, which a
    // stop would no longer keep from showing
    this.actions.cancel.hidden = !this.building || this.keeping;
    this.actions.site.hidden = !local;
    this.actions.clear.hidden = !any && !local;
    if (this.actions.clear.hidden) this.stopAsking();
    if (!this.building) this.say("");
  }

  /**
   * Whether the page shows the flights of the files kept: not the site's,
   * nor theirs of other files (a build of a drop was stopped) or not the
   * latest (one built while the panel was closed, said only by a toast)
   */
  private showsKept(): boolean {
    return (
      !!this.app.config.localFlights &&
      upToDate(this.info, this.files) &&
      this.app.config.localFlights.builtAt === this.info?.builtAt
    );
  }

  /**
   * Remove all asks to be pressed again: for CONFIRM_CLEAR_MS, and on for
   * as long as it has the focus then. Ended without the press, that is
   * said, as the question was.
   */
  private askToClear(): void {
    this.actions.clear.textContent = CONFIRM_CLEAR_LABEL;
    this.askedAt = Date.now();
    const wait = (): void => {
      this.confirming = setTimeout(() => {
        if (document.activeElement === this.actions.clear) wait();
        else this.stopAsking(true);
      }, CONFIRM_CLEAR_MS);
    };
    wait();
    this.say(CONFIRM_CLEAR_MESSAGE);
  }

  /** `lapsed`: it asked, and was not pressed again */
  private stopAsking(lapsed = false): void {
    if (this.confirming === undefined) return;
    clearTimeout(this.confirming);
    this.confirming = undefined;
    this.actions.clear.textContent = ACTIONS.clear;
    if (this.status.textContent === CONFIRM_CLEAR_MESSAGE) {
      this.say(lapsed ? CONFIRM_LAPSED_MESSAGE : "");
    }
  }

  /**
   * Stop the build on its way: the worker goes with it, and the next build
   * starts another. The files stay, and Show my flights builds them again.
   */
  private cancel(): void {
    if (!this.building || this.keeping) return;
    this.builder.destroy();
    this.run++;
    this.building = false;
    this.buildAgain = false;
    this.reveal = false;
    this.render();
    this.say(CANCELLED_MESSAGE);
  }

  /**
   * The ground asked for or not, in this tab (`here`) or another: built
   * again the way asked for, as a changed set of files is, and shown only
   * where the visitor's flights are shown already. A build on its way that
   * fetches the ground, and is asked not to, is let go of first, as a stop
   * lets go of one, before it asks AWS for more of its tiles; another
   * tab's choice builds again only for such a build.
   */
  private groundAsked(here: boolean): void {
    this.terrainOff.checked = noTerrain();
    if (
      this.terrainOff.checked &&
      this.building &&
      !this.keeping &&
      this.buildsGround
    ) {
      this.builder.destroy();
      this.run++;
      this.building = false;
      here = true;
    }
    if (here && this.files.length) void this.build(BUILDING_MESSAGE, false);
  }

  /**
   * Say `message`: in the status, or as an error in the alert beside it,
   * two regions that stay in the panel and in the accessibility tree, so a
   * screen reader hears each as its text changes; an empty one takes no
   * room (local.css), and is never hidden, which took it out of the tree
   * and its next text often went unsaid. An error takes the place of the
   * status; the alert stays until the next thing the visitor does
   * (clearAlert), so a file refused is still said while the rest build.
   */
  private say(message: string, error = false): void {
    (error ? this.alert : this.status).textContent = message;
    if (error) this.status.textContent = "";
  }

  private clearAlert(): void {
    this.alert.textContent = "";
  }

  /**
   * Keep the dropped files and build them; files kept already as they are
   * are only shown
   */
  async add(dropped: Dropped): Promise<void> {
    const kept = this.adding.then(() => this.keep(dropped));
    this.adding = kept.catch(() => undefined);
    // Outside the queue: a drop while a build runs is kept, and built next
    const outcome = await kept;
    if (outcome === "changed") await this.build();
    else if (outcome === "unchanged" && !this.showsKept()) {
      // A build on its way has them already, and shows them once done
      if (this.building) this.reveal = true;
      else await this.show(false);
    }
  }

  /**
   * Keep the dropped files: "changed" when there are any to build,
   * "unchanged" when every one is kept already as it is (dropped again with
   * its name, size and time: a folder dropped again after one flight was
   * added to it), false when nothing came of the drop
   */
  private async keep(
    dropped: Dropped,
  ): Promise<"changed" | "unchanged" | false> {
    this.clearAlert();
    const files: StoredFileWithBytes[] = [];
    let refused = 0;
    const unreadable: string[] = [];
    const oversized: string[] = [];
    const duplicates = new Set<string>();
    const taken = new Map<string, File>();
    // The names of the drop seen, and of the files kept already as they are
    const seen = new Set<string>();
    let unchanged = 0;
    // A large tree takes a while; a build on its way says its own
    const folders = Array.from(dropped).some(
      (item) => "isDirectory" in item && item.isDirectory,
    );
    if (folders && !this.building) this.say(READING_MESSAGE);
    const found = await filesOf(dropped, unreadable);
    if (folders && !this.building) this.say("");
    // Every build takes all the files kept, these among them
    let sizes: Map<string, number>;
    let known: Map<string, StoredFile>;
    try {
      await this.clearing;
      const listed = await listFiles();
      sizes = new Map(listed.map((kept) => [kept.name, kept.size]));
      known = new Map(listed.map((kept) => [kept.name, kept]));
    } catch (error) {
      logError("Could not read the files kept:", error);
      this.say(STORAGE_FAILED_MESSAGE, true);
      return false;
    }
    // By the name each is kept under: an aircraft.json numbered on from
    // those kept, unless it is one of them dropped again (keptAs)
    let aircraft = Math.max(0, ...[...sizes.keys()].map(aircraftNumber));
    for (const file of found) {
      // The AppleDouble files of macOS, which the site build leaves out too
      if (APPLE_DOUBLE.test(file.name)) continue;
      if (!ACCEPTED.test(file.name) && file.name !== AIRCRAFT_FILE) refused++;
      else if (file.size > MAX_FILE_BYTES) oversized.push(file.name);
      else if (file.name === AIRCRAFT_FILE) {
        // One of those kept, of the same bytes, stays as it is
        if (await keptAs(file, sizes.keys())) unchanged++;
        else taken.set(aircraftName(++aircraft), file);
      } else if (seen.has(file.name)) duplicates.add(file.name);
      else {
        seen.add(file.name);
        const old = known.get(file.name);
        if (old?.size === file.size && old.modified === file.lastModified) {
          unchanged++;
        } else taken.set(file.name, file);
      }
    }
    const problems = [
      ...(refused ? [UNSUPPORTED_FILES_MESSAGE] : []),
      ...(oversized.length ? [oversizedMessage(oversized)] : []),
      ...(duplicates.size ? [duplicateMessage([...duplicates])] : []),
    ];
    if (!taken.size) {
      const all = [
        ...problems,
        ...(unreadable.length ? [unreadableMessage(unreadable)] : []),
      ];
      if (unchanged) {
        if (all.length) this.say(all.join(". "), true);
        return "unchanged";
      }
      this.say((all.length ? all : [NO_FILES_MESSAGE]).join(". "), true);
      return false;
    }
    // Kept by name: one of another size under it is said to be replaced
    const replaced: string[] = [];
    for (const [name, { size }] of taken) {
      if ((sizes.get(name) ?? size) !== size) replaced.push(name);
      sizes.set(name, size);
    }
    let total = 0;
    for (const size of sizes.values()) total += size;
    if (total > MAX_KEPT_BYTES) {
      this.say(TOO_LARGE_MESSAGE, true);
      return false;
    }
    for (const [name, file] of taken) {
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch (error) {
        // A file in the cloud that is not on the device, or one changed
        // since it was picked
        logError(`Could not read ${file.name}:`, error);
        unreadable.push(file.name);
        continue;
      }
      files.push({
        name,
        size: file.size,
        bytes,
        added: Date.now(),
        modified: file.lastModified,
      });
    }
    if (unreadable.length) problems.push(unreadableMessage(unreadable));
    if (!files.length) {
      if (problems.length) this.say(problems.join(". "), true);
      return unchanged ? "unchanged" : false;
    }
    const kept = new Set(files.map((file) => file.name));
    const replacedKept = replaced.filter((name) => kept.has(name));
    if (replacedKept.length) problems.push(replacedMessage(replacedKept));
    if (problems.length) this.say(problems.join(". "), true);
    try {
      await putFiles(files);
      void requestPersistence();
    } catch (error) {
      logError("Could not keep the files:", error);
      this.say(storageMessage(error), true);
      return false;
    }
    await this.refresh();
    return "changed";
  }

  private async remove(name: string): Promise<void> {
    this.clearAlert();
    // A build on its way of the file is dropped at once
    this.generation++;
    try {
      await removeFile(name);
    } catch (error) {
      logError("Could not remove the file:", error);
      this.say(STORAGE_FAILED_MESSAGE, true);
      // The file is still kept: the files a build dropped for it, or is
      // dropping, are built again, which takes up what it was asked for
      if (this.building || this.reveal) {
        await this.build(BUILDING_MESSAGE, false);
      }
      return;
    }
    await this.refresh();
    if (this.files.length) await this.build(BUILDING_MESSAGE, false);
    else await this.clear();
  }

  /**
   * Show the flights of the files kept, built again when they changed.
   * `clear`: what the panel said goes (a drop of files kept already says
   * its own)
   */
  private async show(clear = true): Promise<void> {
    if (clear) this.clearAlert();
    await this.refresh();
    if (!this.files.length) return;
    if (upToDate(this.info, this.files)) this.switchTo(true);
    else await this.build();
  }

  /**
   * Build the files kept again, as asked (Build again): a dataset built
   * without what could not be fetched, which the build tries again
   */
  async buildAgainNow(): Promise<void> {
    this.clearAlert();
    await this.refresh();
    this.retry = true;
    await this.build();
  }

  /**
   * Build the files kept again: the dataset is of another deploy, or of
   * other files than those (a build of a drop stopped). One that
   * fails (offline, or no file makes a flight any more) lets the flag go,
   * so the next visit opens on the site's flights rather than trying again
   * on every one; Show my flights tries again when asked to.
   */
  async rebuild(message = REBUILDING_MESSAGE): Promise<void> {
    await this.refresh();
    if (this.files.length) await this.build(message);
    // A page torn down meanwhile let go of the build, not of the flag
    if (this.lifetime.signal.aborted) return;
    if (!upToDate(this.info, this.files)) storeFlag(LOCAL_FLIGHTS_KEY, false);
  }

  private showSite(): void {
    this.switchTo(false);
  }

  private async clear(): Promise<void> {
    this.stopAsking();
    this.clearAlert();
    this.generation++;
    this.buildAgain = false;
    this.reveal = false;
    // The worker goes with its connection to the cache, which can then go
    // as well: the parsed tracks of the flights are in it. The cache goes
    // first, so a failure to clear the files leaves no parse of them
    // behind either.
    this.builder.destroy();
    this.building = false;
    this.run++;
    // Stop the build goes with the build it stopped
    this.render();
    const clearing = (async () => {
      await deleteCache();
      await clearAll();
    })();
    this.clearing = clearing.catch(() => undefined);
    try {
      await clearing;
    } catch (error) {
      logError("Could not remove the files:", error);
      // Another tab of the page holds them: nothing is said to be gone
      const busy =
        error instanceof Error && error.message === CACHE_BUSY_MESSAGE;
      this.render();
      this.say(busy ? CACHE_BUSY_MESSAGE : STORAGE_FAILED_MESSAGE, true);
      return;
    }
    this.forgetLocalState();
    try {
      localStorage.setItem(REMOVED_KEY, String(Date.now()));
    } catch {
      // The other tabs let their saved view go as they start again
    }
    this.files = [];
    this.info = null;
    if (this.app.config.localFlights) {
      this.switchTo(false);
      return;
    }
    this.render();
    this.say(REMOVED_MESSAGE);
  }

  /**
   * Let go of the state saved for the visitor's flights (their view, year,
   * aircraft and selection, see ui/stateManager.ts): it is of the dataset
   * gone, whose next would open on it, with toasts for a year and flights
   * it has not, and Remove all lets everything of the files go
   */
  private forgetLocalState(): void {
    this.app.stateManager?.cancelSave();
    try {
      localStorage.removeItem(LOCAL_STATE_KEY);
    } catch {
      // Nothing was kept
    }
  }

  /** Reload the page on the dataset, or back on the site's flights */
  private switchTo(local: boolean): void {
    storeFlag(LOCAL_FLIGHTS_KEY, local);
    askReopen();
    this.reload();
  }

  /** Show the dataset just built: the state of the last one goes */
  private showBuilt(): void {
    this.forgetLocalState();
    this.switchTo(true);
  }

  /**
   * Build the dataset of the files kept, and switch to it where `reveal`
   * asks for it or the visitor's flights are shown already; it says they
   * are ready otherwise, with the way to them
   */
  private async build(
    message = BUILDING_MESSAGE,
    reveal = true,
  ): Promise<void> {
    // After a Remove all on its way, which may leave nothing to build; and
    // none after the panel is torn down (destroy), by a drop it was keeping
    await this.clearing;
    if (this.lifetime.signal.aborted || !this.files.length) return;
    if (reveal) this.reveal = true;
    if (this.building) {
      this.buildAgain = true;
      return;
    }
    this.building = true;
    this.buildAgain = false;
    const run = ++this.run;
    this.say(message);
    this.render();
    const generation = this.generation;
    try {
      // What is built, whatever is kept by the time it is done; and with
      // the ground as asked for last, in this tab or another, which the
      // box may not show yet: without it, no tile is asked of AWS
      const built = this.files;
      const terrain = !noTerrain();
      this.terrainOff.checked = !terrain;
      this.buildsGround = terrain;
      const config = window.MAP_CONFIG ?? this.app.config;
      // Asked for while the files are read
      const flags = siteFlags(this.app, config);
      const inputs: InputFile[] = [];
      for (const file of built) {
        // The build takes the bytes over; the store keeps its own
        const bytes = await readFileBytes(file.name);
        if (bytes) inputs.push({ name: file.name, bytes });
      }
      const options = {
        flags: await flags,
        version: siteBuild(config),
        retry: this.retry,
      };
      this.retry = false;
      // A file went while they were read, or all of them with the worker
      // and its cache (clear), or the build was stopped: no worker starts
      // again, with a cache of its own, for files no longer kept. And one
      // went while it built: what it made is of them, and a Remove all
      // would come back as the flights it removed.
      const outcome =
        generation !== this.generation || run !== this.run
          ? null
          : await this.builder.build(
              inputs,
              terrain,
              (line) => {
                if (generation === this.generation) {
                  this.say(line.trim() || message);
                }
              },
              options,
            );
      if (!outcome || generation !== this.generation) {
        // A Remove all, or the stop, said what it left
        if (run !== this.run) return;
        this.settle(generation !== this.generation);
        if (this.buildAgain) await this.build(BUILDING_MESSAGE, false);
        return;
      }
      const info: LocalInfo = {
        years: outcome.years,
        flights: outcome.flights,
        airports: outcome.airports,
        bounds: outcome.bounds,
        files: built.map((file) => file.name),
        stamp: fileStamp(built),
        build: siteBuild(config),
        builtAt: Date.now(),
        skipped: outcome.skipped ?? [],
        warnings: outcome.warnings ?? [],
        terrain,
        degraded: outcome.degraded ?? [],
      };
      this.keeping = true;
      this.render();
      try {
        await putDataset(outcome.files, info);
      } finally {
        this.keeping = false;
      }
      // A Remove all while it was kept said what it left
      if (run !== this.run) return;
      this.info = info;
      // And a file removed meanwhile builds again (buildAgain)
      if (this.buildAgain || generation !== this.generation) {
        this.settle(generation !== this.generation);
        if (this.buildAgain) await this.build(BUILDING_MESSAGE, false);
        return;
      }
      const reveal = this.reveal || !!this.app.config.localFlights;
      this.building = false;
      this.reveal = false;
      // The visitor moved on while it built (the first build takes a
      // while): the page is not reloaded under a replay, the tour or
      // Wrapped, or with the panel closed, but says it is ready. Nor for
      // a removal or the ground asked for while the site's flights show.
      if (reveal && this.isOpen() && !this.app.mapHeld) {
        this.say(BUILT_MESSAGE);
        this.showBuilt();
        return;
      }
      this.render();
      this.say(READY_MESSAGE);
      showToast(READY_MESSAGE, "info", {
        label: "Show",
        run: () => this.showBuilt(),
      });
    } catch (error) {
      // Let go of by a Remove all or the stop (the worker went with it),
      // which said what it left
      if (run !== this.run) return;
      // Another tab let go of the cache for its Remove all: the files went
      // with it, which the list then shows too, unless that tab could not
      // remove them (a third held them), and those kept are built again
      const gone = (error as Error | null)?.message === CACHE_GONE_MESSAGE;
      if (gone) {
        await this.refresh();
        if (run !== this.run) return;
        if (this.files.length) this.buildAgain = true;
      }
      this.settle(generation !== this.generation);
      // Of files since removed: what it failed with is not of those kept
      if (generation === this.generation && !(gone && this.files.length)) {
        logError("The build of the flights failed:", error);
        const message =
          error instanceof DOMException
            ? storageMessage(error)
            : error instanceof Error
              ? error.message
              : String(error);
        this.say(message, true);
        // Unseen in a panel that is closed or held under Wrapped, where a
        // build that got through says so with a toast as well; one that
        // stays while the map is held, which holds the panel inert
        if (!this.isOpen() || this.app.mapHeld) {
          showToast(message, "error", {
            label: "Show",
            run: () => (this.app.mapHeld ? false : this.open()),
          });
        }
      }
      if (this.buildAgain) await this.build(BUILDING_MESSAGE, false);
    }
  }

  /**
   * A build ended without showing what it made. `removed`: of files since
   * removed, whose removal builds the rest next (remove)
   */
  private settle(removed = false): void {
    this.building = false;
    // Kept for the build asked for meanwhile, or on its way, which goes on
    if (!this.buildAgain && !removed) this.reveal = false;
    this.render();
  }
}

let current: LocalFlights | null = null;

/** Open or close the panel; `dropped` files are added as it opens */
export function toggleLocalFlights(app: MapApp, dropped?: Dropped): void {
  if (framed()) {
    showToast(FRAMED_MESSAGE, "info");
    return;
  }
  // Wrapped's dialog would hold the panel inert under it, with what the
  // build says
  if (dropped && app.wrappedVisible) {
    showToast(DROP_IN_WRAPPED_MESSAGE, "info");
    return;
  }
  if (current?.app !== app) {
    current?.destroy();
    current = new LocalFlights(app);
  }
  if (dropped) {
    if (!current.isOpen()) current.open();
    void current.add(dropped);
    return;
  }
  if (!current.isOpen() && app.mapHeld) return;
  current.toggle();
}

/**
 * The controls that copy a link say they cannot while the page shows the
 * visitor's flights, as an unavailable control does (dimmed, its title
 * saying why): a link would open the site's flights (ui/uiToggles.ts)
 */
function holdShareControls(): void {
  for (const id of SHARE_CONTROL_IDS) {
    const control = document.getElementById(id);
    if (control) setUnavailable(control, true, SHARE_UNAVAILABLE_MESSAGE);
  }
}

/**
 * After the start: the panel reopened after a reload that switched the
 * flights, if it was asked for, or opened to build the files again for a
 * dataset another deploy made (localStartConfig)
 */
export function reopenAfterSwitch(
  app: MapApp,
  // The page's address without the link's state: the visitor's flights
  showMine: () => void = () => location.replace(location.pathname),
  // The same, after another tab removed them: the site's, as the start
  // then finds none (localStartConfig)
  showSite: () => void = showMine,
): void {
  started = app;
  // Started on the site's flights, with nothing to reopen (localStartConfig)
  if (framed()) return;
  if (app.config.localFlights) {
    holdShareControls();
    // Another tab's Remove all: this one would save its view of the flights
    // gone at every pan, under a key nothing removes once the page starts
    // on the site's again
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key !== REMOVED_KEY || !event.newValue) return;
        app.stateManager?.cancelSave();
        try {
          localStorage.removeItem(LOCAL_STATE_KEY);
        } catch {
          // Nothing was kept
        }
        showSite();
      },
      { signal: app.signal },
    );
  }
  if (linkedAway) {
    linkedAway = false;
    // Said, with the way back: the flag is kept, but a visitor who
    // followed a link of their own (an old bookmark) lost sight of theirs
    showToast(LINK_OPENED_SITE_MESSAGE, "info", {
      label: "Show my flights",
      run: () => {
        markOwnTab();
        showMine();
      },
    });
  }
  const degraded = app.config.localFlights?.degraded;
  if (degraded?.length && !saidThisTab()) {
    // The connection may be back: the visitor is offered the build that
    // gets what this one could not, once a tab; not while the map is held
    // (Wrapped), which keeps the panel closed, and the toast stays
    showToast(degradedMessage(degraded), "info", {
      label: BUILD_AGAIN_LABEL,
      run: () => {
        if (app.mapHeld) return false;
        if (current?.app !== app || !current.isOpen()) toggleLocalFlights(app);
        void current?.buildAgainNow();
        return true;
      },
    });
  }
  if (staleAtStart) {
    const message = staleAtStart;
    staleAtStart = null;
    takeReopen();
    toggleLocalFlights(app);
    void current?.rebuild(message);
  } else if (takeReopen()) toggleLocalFlights(app);
  else if (app.config.localFlights) {
    // The button says the page shows the visitor's flights
    document.getElementById(LOCAL_BUTTON_ID)?.classList.add("active");
  }
}
