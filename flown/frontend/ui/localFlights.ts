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
import { escapeHtml } from "../utils/escape";
import { formatFileSize } from "../utils/formatters";
import { icon } from "../utils/icons";
import { isPageEscape } from "../utils/mapHelpers";
import { logError } from "../utils/logger";
import { storeFlag } from "../utils/storedFlag";
import { askReopen, LOCAL_FLIGHTS_KEY, takeReopen } from "../state/localFlags";

/** The button in the left column, and the row of the phone's More sheet */
export const LOCAL_BUTTON_ID = "local-flights-btn";
export const LOCAL_PANEL_ID = "local-flights";
/** The data directory of the dataset: what the loader asks for under it */
export const LOCAL_DATA_DIR = "local";
/** Pixels between the button and the panel beside it */
const PANEL_GAP_PX = 8;

const ACCEPTED = /\.(kml|kmz)$/i;
const AIRCRAFT_FILE = "aircraft.json";

export const SITE_FLIGHTS_MESSAGE = "Showing the site's flights";
export const NO_FILES_MESSAGE =
  "Drop the KML or KMZ files of your flights here, or choose them";
export const UNSUPPORTED_FILES_MESSAGE =
  "Only KML and KMZ files, and an aircraft.json next to them, can be shown";
export const BUILDING_MESSAGE = "Building your flights…";
export const BUILT_MESSAGE = "Built, opening your flights…";
export const STORAGE_FAILED_MESSAGE =
  "This browser does not let the page keep files";
export const REMOVED_MESSAGE = "Your files are removed from this browser";
/** What one drop may add in all: three copies of it are held while it builds */
export const MAX_DROP_BYTES = 200 * 1024 * 1024;
export const TOO_LARGE_MESSAGE =
  "That is more than 200 MB at once; drop fewer files at a time";

/** What the panel says about what is shown */
export function shownMessage(info: LocalInfo | null | undefined): string {
  if (!info) return SITE_FLIGHTS_MESSAGE;
  const flights = `${info.flights} flight${info.flights === 1 ? "" : "s"}`;
  const files = `${info.files.length} file${info.files.length === 1 ? "" : "s"}`;
  return `Showing your ${flights} from ${files}`;
}

/** The build of the page, which a dataset of another is not read by */
const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/**
 * Whether the dataset was built from exactly the files kept, by this build
 * of the site: another's may write the year files in another format
 */
export function upToDate(info: LocalInfo | null, files: StoredFile[]): boolean {
  return !!info && info.build === BUILD && info.stamp === fileStamp(files);
}

function decode(bytes: ArrayBuffer): string {
  return new TextDecoder().decode(bytes);
}

/**
 * The configuration of a page that starts from the dataset in the
 * browser, or null when there is none (the flag is then cleared, and the
 * page starts from the site's flights as it would without it).
 */
export async function localStartConfig(
  config: MapConfig,
): Promise<MapConfig | null> {
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
  // Built by another deploy of the site, whose year files may be of
  // another format, or of other files than the ones kept (a file removed
  // while the rebuild failed): the page starts on the site's flights, and
  // the panel builds the files again as soon as they are asked for
  if (!upToDate(info, files)) return giveUp();
  const prefix = `${LOCAL_DATA_DIR}/`;
  const bytesOf = async (url: string): Promise<ArrayBuffer> => {
    const path = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    const bytes = await readDatasetFile(path);
    if (!bytes) throw new Error(`Not in this browser: ${url}`);
    return bytes;
  };
  return {
    ...config,
    center: info!.center,
    bounds: info!.bounds,
    dataDir: LOCAL_DATA_DIR,
    dataSource: {
      fetchJson: async (url): Promise<unknown> =>
        JSON.parse(decode(await bytesOf(url))),
      fetchBytes: bytesOf,
    },
    localFlights: info!,
  };
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
  '<input type="file" multiple accept=".kml,.kmz,.json" ' +
  'aria-label="Choose the KML or KMZ files of your flights"></label>' +
  '<ul class="local-flights-files" aria-label="Your files"></ul>' +
  '<p class="local-flights-status" role="status"></p>' +
  '<div class="local-flights-actions">' +
  '<button type="button" class="btn-surface" data-local="show">Show my flights</button>' +
  '<button type="button" class="btn-surface" data-local="site">Show the site’s flights</button>' +
  '<button type="button" class="btn-surface" data-local="clear">Remove all</button>' +
  "</div>" +
  '<p class="local-flights-note">Nothing leaves this browser: the files and ' +
  "the map built from them are kept in its storage. The build fetches its " +
  "Python runtime from a CDN, the airport names from OurAirports and the " +
  "ground under the flights from the same elevation tiles as the 3D view, " +
  "and sends them nothing of the files.</p>";

export class LocalFlights {
  readonly panel: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private readonly input: HTMLInputElement;
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
    panel.innerHTML = PANEL_HTML;
    this.panel = panel;
    this.shown = panel.querySelector(".local-flights-shown")!;
    this.list = panel.querySelector(".local-flights-files")!;
    this.status = panel.querySelector(".local-flights-status")!;
    this.input = panel.querySelector("input")!;
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
    panel.addEventListener(
      "keydown",
      (event) => {
        if (isPageEscape(event)) {
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
    this.list.innerHTML = this.files
      .map(
        (file) =>
          `<li><span class="local-flights-name">${escapeHtml(file.name)}</span>` +
          `<span class="local-flights-size">${formatFileSize(file.size)}</span>` +
          `<button type="button" class="local-flights-remove" data-remove="${escapeHtml(file.name)}" ` +
          `title="Remove ${escapeHtml(file.name)}" aria-label="Remove ${escapeHtml(file.name)}">` +
          icon("close", 16) +
          "</button></li>",
      )
      .join("");
    const any = this.files.length > 0;
    // Show my flights: the dataset is there and the page shows the site's;
    // a changed set of files is built again as it is shown
    this.actions.show.hidden = !any || local || this.building;
    this.actions.site.hidden = !local;
    this.actions.clear.hidden = !any && !local;
    if (!this.building && !this.status.classList.contains("is-error")) {
      this.say(any ? "" : NO_FILES_MESSAGE);
    }
  }

  private say(message: string, error = false): void {
    this.status.textContent = message;
    this.status.hidden = !message;
    this.status.classList.toggle("is-error", error);
    this.status.setAttribute("role", error ? "alert" : "status");
  }

  /** Keep the dropped files and build them */
  async add(dropped: FileList | File[]): Promise<void> {
    const files: StoredFileWithBytes[] = [];
    let refused = 0;
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
      files.push({
        name: file.name,
        size: file.size,
        bytes: await file.arrayBuffer(),
        added: Date.now(),
      });
    }
    if (refused) this.say(UNSUPPORTED_FILES_MESSAGE, true);
    if (!files.length) return;
    try {
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
    await this.refresh();
    if (!this.files.length) return;
    if (upToDate(this.info, this.files)) this.switchTo(true);
    else await this.build();
  }

  private showSite(): void {
    this.switchTo(false);
  }

  private async clear(): Promise<void> {
    this.generation++;
    this.buildAgain = false;
    // The worker goes with its connection to the cache, which can then go
    // as well: the parsed tracks of the flights are in it
    this.builder.destroy();
    this.building = false;
    try {
      await clearAll();
      await deleteCache();
    } catch (error) {
      logError("Could not remove the files:", error);
      this.say(STORAGE_FAILED_MESSAGE, true);
      return;
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

  /** Reload the page on the dataset, or back on the site's flights */
  private switchTo(local: boolean): void {
    storeFlag(LOCAL_FLIGHTS_KEY, local);
    askReopen();
    this.reload();
  }

  /** Build the dataset of the files kept, and switch to it */
  private async build(): Promise<void> {
    if (this.building) {
      this.buildAgain = true;
      return;
    }
    this.building = true;
    this.buildAgain = false;
    this.say(BUILDING_MESSAGE);
    this.render();
    const generation = this.generation;
    try {
      // What is built, whatever is kept by the time it is done
      const built = this.files;
      const inputs: InputFile[] = [];
      for (const file of built) {
        // The build takes the bytes over; the store keeps its own
        const bytes = await readFileBytes(file.name);
        if (bytes) inputs.push({ name: file.name, bytes });
      }
      const outcome = await this.builder.build(inputs, true, (line) => {
        if (generation === this.generation) {
          this.say(line.trim() || BUILDING_MESSAGE);
        }
      });
      // A file went while it built: what it made is of files no longer
      // kept, and a Remove all would come back as the flights it removed
      if (generation !== this.generation) {
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
        build: BUILD,
        builtAt: Date.now(),
      };
      await putDataset(outcome.files, info);
      this.info = info;
      this.say(BUILT_MESSAGE);
      this.building = false;
      if (this.buildAgain) {
        await this.build();
        return;
      }
      this.switchTo(true);
    } catch (error) {
      this.building = false;
      logError("The build of the flights failed:", error);
      this.say(error instanceof Error ? error.message : String(error), true);
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

/** The panel after a reload that switched the flights, if it was asked for */
export function reopenAfterSwitch(app: MapApp): void {
  if (takeReopen()) toggleLocalFlights(app);
  else if (app.config.localFlights) {
    // The button says the page shows the visitor's flights
    document.getElementById(LOCAL_BUTTON_ID)?.classList.add("active");
  }
}
