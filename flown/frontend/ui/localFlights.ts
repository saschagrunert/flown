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

/** The button in the left column, and the row of the phone's More sheet */
export const LOCAL_BUTTON_ID = "local-flights-btn";
export const LOCAL_PANEL_ID = "local-flights";
/** The data directory of the dataset: what the loader asks for under it */
export const LOCAL_DATA_DIR = "local";
/** Pixels between the button and the panel beside it */
const PANEL_GAP_PX = 8;

const ACCEPTED = /\.(kml|kmz)$/i;
const AIRCRAFT_FILE = "aircraft.json";
/** How a file is named for its aircraft, which the hint links to */
const NAMING_DOCS_URL =
  "https://github.com/saschagrunert/flown/blob/main/doc/usage.md#kml-file-naming-convention";
/** The controls that copy a link to the site (ui/uiToggles.ts, shareLink) */
const SHARE_CONTROL_IDS = ["share-btn", "selection-link-btn"];

/** Set while the visitor asked for their flights without the ground */
export const NO_TERRAIN_KEY = keyedToPage("flown-local-no-terrain");
/**
 * Set in a tab once it started on the visitor's flights: a state in its
 * address is of its own history there, not a link opened on it (see
 * localStartConfig; the page writes none while it shows them)
 */
export const OWN_TAB_KEY = keyedToPage("flown-local-tab");

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
export const STORAGE_FAILED_MESSAGE =
  "This browser does not let the page keep files";
export const REMOVED_MESSAGE = "Your files are removed from this browser";
/** What one drop may add in all: three copies of it are held while it builds */
export const MAX_DROP_BYTES = 200 * 1024 * 1024;
export const TOO_LARGE_MESSAGE =
  "That is more than 200 MB at once; drop fewer files at a time";

/**
 * Said in a page framed by another: Your flights does not open there (see
 * framed)
 */
export const FRAMED_MESSAGE =
  "Your flights opens only on the site itself, not inside another page";

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

/**
 * Said of dropped files that took the place of others kept under their
 * names, which were of another size: the store keeps one file a name
 */
export function replacedMessage(names: readonly string[]): string {
  return `${names.join(", ")} replaced ${names.length === 1 ? "a file" : "files"} of the same name`;
}

/** Said of files the browser would not read (one moved since it was picked) */
export function unreadableMessage(names: readonly string[]): string {
  return `Could not read ${names.join(", ")}; pick ${names.length === 1 ? "it" : "them"} again`;
}

/** What the panel says about what is shown */
export function shownMessage(info: LocalInfo | null | undefined): string {
  if (!info) return SITE_FLIGHTS_MESSAGE;
  const flights = `${info.flights} flight${info.flights === 1 ? "" : "s"}`;
  const files = `${info.files.length} file${info.files.length === 1 ? "" : "s"}`;
  return `Showing your ${flights} from ${files}`;
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
    (info.terrain !== false) === !storedFlag(NO_TERRAIN_KEY)
  );
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
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

/** Set by a start whose dataset another deploy built: the panel rebuilds */
let staleAtStart = false;
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
  if (!info || !files.length) return giveUp();
  // Of other files than the ones kept (a file removed while the rebuild
  // failed) as well: built again as the panel opens
  if (!upToDate(info, files, config)) {
    staleAtStart = true;
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
    center: info.center,
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
  "for the model names. Up to 200 MB at a time.</p>" +
  '<ul class="local-flights-files" aria-label="Your files"></ul>' +
  '<ul class="local-flights-warnings" aria-label="What the build said" hidden></ul>' +
  '<p class="local-flights-status" role="status"></p>' +
  '<p class="local-flights-status is-error" role="alert"></p>' +
  '<label class="local-flights-terrain"><input type="checkbox"> ' +
  "Without the ground under the flights</label>" +
  '<div class="local-flights-actions">' +
  '<button type="button" class="btn-surface" data-local="show">Show my flights</button>' +
  '<button type="button" class="btn-surface" data-local="site">Show the site’s flights</button>' +
  '<button type="button" class="btn-surface" data-local="clear">Remove all</button>' +
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
  private readonly actions: Record<
    "show" | "site" | "clear",
    HTMLButtonElement
  >;
  private files: StoredFile[] = [];
  private info: LocalInfo | null;
  private building = false;
  private buildAgain = false;
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
    this.terrainOff.checked = storedFlag(NO_TERRAIN_KEY);
    this.actions = {
      show: panel.querySelector('[data-local="show"]')!,
      site: panel.querySelector('[data-local="site"]')!,
      clear: panel.querySelector('[data-local="clear"]')!,
    };
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
        storeFlag(NO_TERRAIN_KEY, this.terrainOff.checked);
        // Built again the way asked for, as a changed set of files is
        this.clearAlert();
        if (this.files.length) void this.build();
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
        const dropped = event.dataTransfer?.files;
        if (dropped?.length) void this.add(dropped);
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
    this.actions.site.addEventListener("click", () => this.showSite(), listen);
    this.actions.clear.addEventListener(
      "click",
      () => void this.clear(),
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
    const focused = this.panel.contains(document.activeElement);
    this.panel.hidden = true;
    this.setButtonExpanded(false);
    if (restoreFocus && focused) {
      [this.opener, document.getElementById(LOCAL_BUTTON_ID)]
        .find((element) => element?.isConnected)
        ?.focus();
    }
  }

  destroy(): void {
    this.lifetime.abort();
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

  /** The files kept, read again: another tab may have changed them */
  private async refresh(): Promise<void> {
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
    // Show my flights: the dataset is there and the page shows the site's;
    // a changed set of files is built again as it is shown
    this.actions.show.hidden = !any || local || this.building;
    this.actions.site.hidden = !local;
    this.actions.clear.hidden = !any && !local;
    if (!this.building) this.say("");
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

  /** Keep the dropped files and build them */
  async add(dropped: FileList | File[]): Promise<void> {
    this.clearAlert();
    const files: StoredFileWithBytes[] = [];
    let refused = 0;
    const unreadable: string[] = [];
    const taken = Array.from(dropped);
    if (taken.reduce((sum, file) => sum + file.size, 0) > MAX_DROP_BYTES) {
      this.say(TOO_LARGE_MESSAGE, true);
      return;
    }
    for (const file of taken) {
      if (!ACCEPTED.test(file.name) && file.name !== AIRCRAFT_FILE) {
        refused++;
        continue;
      }
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
        name: file.name,
        size: file.size,
        bytes,
        added: Date.now(),
      });
    }
    const problems = [
      ...(refused ? [UNSUPPORTED_FILES_MESSAGE] : []),
      ...(unreadable.length ? [unreadableMessage(unreadable)] : []),
    ];
    if (!files.length) {
      if (problems.length) this.say(problems.join(". "), true);
      return;
    }
    try {
      await this.clearing;
      // Kept by name: one of another size under it is said to be replaced
      const sizes = new Map(
        (await listFiles()).map((kept) => [kept.name, kept.size]),
      );
      const replaced: string[] = [];
      for (const { name, size } of files) {
        if ((sizes.get(name) ?? size) !== size) replaced.push(name);
        sizes.set(name, size);
      }
      if (replaced.length) problems.push(replacedMessage(replaced));
      if (problems.length) this.say(problems.join(". "), true);
      await putFiles(files);
      void requestPersistence();
    } catch (error) {
      logError("Could not keep the files:", error);
      this.say(STORAGE_FAILED_MESSAGE, true);
      return;
    }
    await this.refresh();
    await this.build();
  }

  private async remove(name: string): Promise<void> {
    this.clearAlert();
    this.generation++;
    try {
      await removeFile(name);
    } catch (error) {
      logError("Could not remove the file:", error);
      this.say(STORAGE_FAILED_MESSAGE, true);
      return;
    }
    await this.refresh();
    if (this.files.length) await this.build();
    else await this.clear();
  }

  /** Show the flights of the files kept, built again when they changed */
  private async show(): Promise<void> {
    this.clearAlert();
    await this.refresh();
    if (!this.files.length) return;
    if (upToDate(this.info, this.files)) this.switchTo(true);
    else await this.build();
  }

  /**
   * Build the files kept again: the dataset is of another deploy. One that
   * fails (offline, or no file makes a flight any more) lets the flag go,
   * so the next visit opens on the site's flights rather than trying again
   * on every one; Show my flights tries again when asked to.
   */
  async rebuild(): Promise<void> {
    await this.refresh();
    if (this.files.length) await this.build(REBUILDING_MESSAGE);
    if (!upToDate(this.info, this.files)) storeFlag(LOCAL_FLIGHTS_KEY, false);
  }

  private showSite(): void {
    this.switchTo(false);
  }

  private async clear(): Promise<void> {
    this.clearAlert();
    this.generation++;
    this.buildAgain = false;
    // The worker goes with its connection to the cache, which can then go
    // as well: the parsed tracks of the flights are in it. The cache goes
    // first, so a failure to clear the files leaves no parse of them
    // behind either.
    this.builder.destroy();
    this.building = false;
    this.run++;
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
      this.say(busy ? CACHE_BUSY_MESSAGE : STORAGE_FAILED_MESSAGE, true);
      return;
    }
    this.forgetLocalState();
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

  /** Build the dataset of the files kept, and switch to it */
  private async build(message = BUILDING_MESSAGE): Promise<void> {
    // After a Remove all on its way, which may leave nothing to build
    await this.clearing;
    if (!this.files.length) return;
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
      // What is built, whatever is kept by the time it is done
      const built = this.files;
      const terrain = !this.terrainOff.checked;
      const config = window.MAP_CONFIG ?? this.app.config;
      // Asked for while the files are read
      const flags = siteFlags(this.app, config);
      const inputs: InputFile[] = [];
      for (const file of built) {
        // The build takes the bytes over; the store keeps its own
        const bytes = await readFileBytes(file.name);
        if (bytes) inputs.push({ name: file.name, bytes });
      }
      const options = { flags: await flags, version: siteBuild(config) };
      // A file went while they were read, or all of them with the worker
      // and its cache (clear): no worker starts again, with a cache of its
      // own, for files no longer kept. And one went while it built: what it
      // made is of them, and a Remove all would come back as the flights
      // it removed.
      const outcome =
        generation !== this.generation
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
        // A Remove all said what it left
        if (run !== this.run) return;
        this.building = false;
        this.render();
        if (this.buildAgain) await this.build();
        return;
      }
      const info: LocalInfo = {
        years: outcome.years,
        flights: outcome.flights,
        airports: outcome.airports,
        center: outcome.center,
        bounds: outcome.bounds,
        files: built.map((file) => file.name),
        stamp: fileStamp(built),
        build: siteBuild(config),
        builtAt: Date.now(),
        skipped: outcome.skipped ?? [],
        warnings: outcome.warnings ?? [],
        terrain,
      };
      await putDataset(outcome.files, info);
      this.info = info;
      this.building = false;
      if (this.buildAgain) {
        await this.build();
        return;
      }
      // The visitor moved on while it built (the first build takes a
      // while): the page is not reloaded under a replay, the tour or
      // Wrapped, or with the panel closed, but says it is ready
      if (this.isOpen() && !this.app.mapHeld) {
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
      // Let go of by a Remove all (the worker went with it), which said
      // what it left
      if (run !== this.run) return;
      this.building = false;
      // Of files since removed: what it failed with is not of those kept
      if (generation === this.generation) {
        logError("The build of the flights failed:", error);
        this.say(error instanceof Error ? error.message : String(error), true);
      }
      this.render();
      if (this.buildAgain) await this.build();
    }
  }
}

let current: LocalFlights | null = null;

/** Open or close the panel; `dropped` files are added as it opens */
export function toggleLocalFlights(
  app: MapApp,
  dropped?: FileList | File[],
): void {
  if (framed()) {
    showToast(FRAMED_MESSAGE, "info");
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
): void {
  started = app;
  // Started on the site's flights, with nothing to reopen (localStartConfig)
  if (framed()) return;
  if (app.config.localFlights) holdShareControls();
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
  if (staleAtStart) {
    staleAtStart = false;
    takeReopen();
    toggleLocalFlights(app);
    void current?.rebuild();
  } else if (takeReopen()) toggleLocalFlights(app);
  else if (app.config.localFlights) {
    // The button says the page shows the visitor's flights
    document.getElementById(LOCAL_BUTTON_ID)?.classList.add("active");
  }
}
