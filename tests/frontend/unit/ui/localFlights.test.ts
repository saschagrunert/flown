/**
 * Your flights (ui/localFlights.ts): the panel that takes the KML files a
 * visitor drops, keeps them in the browser, builds them in a worker and
 * reloads the page on what the build made. The store and the builder are
 * doubles here, and the reload a spy: a test reads what was kept, what was
 * built, which flag the next page starts from and whether it reloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  LOCAL_BUTTON_ID,
  LOCAL_DATA_DIR,
  LOCAL_PANEL_ID,
  CONFIRM_CLEAR_MS,
  LocalFlights,
  NO_TERRAIN_KEY,
  REBUILT_ADDRESS_KEY,
  REMOVED_KEY,
  STOPPED_KEY,
  localStartConfig,
  reopenAfterSwitch,
  siteBuild,
  toggleLocalFlights,
  upToDate,
} from "../../../../flown/frontend/ui/localFlights";
import {
  BUILDING_MESSAGE,
  BUILT_MESSAGE,
  FRAMED_MESSAGE,
  CANCELLED_MESSAGE,
  BUILD_AGAIN_LABEL,
  CONFIRM_CLEAR_LABEL,
  CONFIRM_CLEAR_MESSAGE,
  CONFIRM_LAPSED_MESSAGE,
  aircraftName,
  aircraftNumber,
  degradedMessage,
  duplicateMessage,
  MAX_FILE_BYTES,
  MAX_KEPT_BYTES,
  oversizedMessage,
  STORAGE_FULL_MESSAGE,
  TOO_LARGE_MESSAGE,
  LINK_OPENED_SITE_MESSAGE,
  NO_FILES_MESSAGE,
  READY_MESSAGE,
  REBUILDING_MESSAGE,
  REMOVED_MESSAGE,
  SITE_FLIGHTS_MESSAGE,
  STORAGE_FAILED_MESSAGE,
  UNSUPPORTED_FILES_MESSAGE,
  replacedMessage,
  shownMessage,
  unreadableMessage,
} from "../../../../flown/frontend/ui/localMessages";
import {
  LOCAL_FLIGHTS_KEY,
  LOCAL_STATE_KEY,
  REOPEN_KEY,
} from "../../../../flown/frontend/state/localFlags";
import {
  LocalBuilder,
  type BuildOutcome,
} from "../../../../flown/frontend/services/localBuild";
import {
  CACHE_BUSY_MESSAGE,
  CACHE_GONE_MESSAGE,
  fileStamp,
  type LocalInfo,
  type StoredFile,
  type StoredFileWithBytes,
} from "../../../../flown/frontend/services/localStore";
import { logError } from "../../../../flown/frontend/utils/logger";
import { DROP_IN_WRAPPED_MESSAGE } from "../../../../flown/frontend/ui/fileDrop";
import { siteData } from "../../../../flown/frontend/state/siteData";
import {
  asMapApp,
  createMockApp,
  stubAnimationFrames,
  type MockApp,
} from "../../testHelpers";

const store = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFileBytes: vi.fn(),
  putFiles: vi.fn(),
  removeFile: vi.fn(),
  putDataset: vi.fn(),
  readInfo: vi.fn(),
  readDatasetFile: vi.fn(),
  clearAll: vi.fn(),
  deleteCache: vi.fn(),
  requestPersistence: vi.fn(),
}));
// The stamp of a set of files is the real one: what the panel compares by
vi.mock(
  "../../../../flown/frontend/services/localStore",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../flown/frontend/services/localStore")
    >()),
    ...store,
  }),
);
vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

function stored(name: string, size = 3): StoredFile {
  return { name, size, added: 1 };
}

/** What a build of a.kml and b.kml, as stored(), made; of this build */
const INFO: LocalInfo = {
  years: [2025],
  flights: 3,
  airports: 2,
  bounds: [
    [50, 11],
    [52, 13],
  ],
  files: ["a.kml", "b.kml"],
  stamp: fileStamp([stored("a.kml"), stored("b.kml")]),
  build: undefined,
  builtAt: 1,
};

const OUTCOME: BuildOutcome = {
  years: [2025],
  flights: 1,
  airports: 2,
  bounds: [
    [51.1, 12.0],
    [51.5, 13.7],
  ],
  files: [{ path: "metadata.json", bytes: new ArrayBuffer(2) }],
};

/** A build the test settles by hand, in the order the builds were asked for */
function fakeBuilder() {
  const settlers: {
    resolve: (outcome: BuildOutcome) => void;
    reject: (error: Error) => void;
    progress: (line: string) => void;
  }[] = [];
  const build = vi.fn(
    (
      _files: unknown,
      _terrain: boolean,
      progress: (line: string) => void,
      _options?: unknown,
    ): Promise<BuildOutcome> =>
      new Promise((resolve, reject) => {
        settlers.push({ resolve, reject, progress });
      }),
  );
  const builder = {
    build,
    destroy: vi.fn(),
    get busy() {
      return false;
    },
  };
  return { builder: builder as unknown as LocalBuilder, build, settlers };
}

/** A file as the picker or a drop hands it over */
function file(name: string, content = "<kml/>"): File {
  return new File([content], name);
}

let app: MockApp;
let reload: ReturnType<typeof vi.fn<() => void>>;
let fake: ReturnType<typeof fakeBuilder>;
let button: HTMLButtonElement;

const panel = (): HTMLElement => document.getElementById(LOCAL_PANEL_ID)!;
const status = (): HTMLElement =>
  panel().querySelector<HTMLElement>('.local-flights-status[role="status"]')!;
const alert = (): HTMLElement =>
  panel().querySelector<HTMLElement>('.local-flights-status[role="alert"]')!;
const shown = (): string =>
  panel().querySelector(".local-flights-shown")!.textContent ?? "";
const action = (
  name: "show" | "again" | "cancel" | "site" | "clear",
): HTMLButtonElement =>
  panel().querySelector<HTMLButtonElement>(`[data-local="${name}"]`)!;
const names = (): string[] =>
  Array.from(
    panel().querySelectorAll(".local-flights-name"),
    (name) => name.textContent ?? "",
  );
/** Remove all, pressed twice as it asks (CONFIRM_CLEAR_LABEL) */
const removeAll = (): void => {
  action("clear").click();
  action("clear").click();
};
const closeButton = (): HTMLElement =>
  panel().querySelector<HTMLElement>(".local-flights-close")!;

/** Let the promise chains of the panel settle */
async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

function makePanel(
  overrides: Parameters<typeof createMockApp>[0] = {},
): LocalFlights {
  app = createMockApp(overrides);
  fake = fakeBuilder();
  reload = vi.fn<() => void>();
  return new LocalFlights(asMapApp(app), fake.builder, reload);
}

/** A panel opened, with the files of the store read into it */
async function openPanel(
  overrides: Parameters<typeof createMockApp>[0] = {},
): Promise<LocalFlights> {
  const local = makePanel(overrides);
  local.open();
  await settle();
  return local;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.listFiles.mockResolvedValue([]);
  store.readInfo.mockResolvedValue(null);
  store.deleteCache.mockResolvedValue(undefined);
  store.putFiles.mockResolvedValue(undefined);
  store.removeFile.mockResolvedValue(undefined);
  store.putDataset.mockResolvedValue(undefined);
  store.clearAll.mockResolvedValue(undefined);
  store.requestPersistence.mockResolvedValue(true);
  store.readDatasetFile.mockResolvedValue(null);
  // A file's bytes are its name, but an aircraft file's: {} (file())
  store.readFileBytes.mockImplementation((name: string) =>
    Promise.resolve(new Blob([aircraftNumber(name) ? "{}" : name])),
  );
  // The site's metadata.json, which the build asks for its flags: offline
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
  document.body.innerHTML = '<main><div id="map"></div></main>';
  button = document.createElement("button");
  button.id = LOCAL_BUTTON_ID;
  document.body.prepend(button);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The module-level panel of toggleLocalFlights, if a test made one
  const app2 = createMockApp();
  toggleLocalFlights(asMapApp(app2));
  document.getElementById(LOCAL_PANEL_ID)?.remove();
  document.body.innerHTML = "";
});

describe("shownMessage", () => {
  it("names the site's flights without a dataset", () => {
    expect(shownMessage(null)).toBe(SITE_FLIGHTS_MESSAGE);
    expect(shownMessage(undefined)).toBe(SITE_FLIGHTS_MESSAGE);
  });

  it("counts the flights and the files, singular and plural", () => {
    expect(shownMessage(INFO)).toBe("Showing your 3 flights from 2 files");
    expect(shownMessage({ ...INFO, flights: 1, files: ["a.kml"] })).toBe(
      "Showing your 1 flight from 1 file",
    );
  });

  it("counts only the files the flights are of", () => {
    // Not the aircraft files, nor a file the build left out
    expect(
      shownMessage({
        ...INFO,
        flights: 2,
        files: ["a.kml", "b.KMZ", "c.kml", "aircraft.json", "aircraft-2.json"],
        skipped: [{ file: "c.kml", reason: "no flight" }],
      }),
    ).toBe("Showing your 2 flights from 2 files");
  });
});

describe("degradedMessage", () => {
  it("names what the build went without", () => {
    expect(degradedMessage(["airports"])).toBe(
      "Your flights were built without the airport names, which could not be fetched",
    );
    expect(degradedMessage(["airports", "terrain"])).toBe(
      "Your flights were built without the airport names and the ground " +
        "under the flights, which could not be fetched",
    );
    // The runways alone, not the airport names the build has
    expect(degradedMessage(["runways", "terrain"])).toBe(
      "Your flights were built without the runways and the ground under " +
        "the flights, which could not be fetched",
    );
    expect(degradedMessage(["other"])).toContain("some of their data");
  });
});

describe("the panel", () => {
  it("is made hidden ahead of the map, and points the button at itself", () => {
    const local = makePanel();

    expect(local.panel.hidden).toBe(true);
    expect(local.panel.nextElementSibling?.tagName).toBe("MAIN");
    expect(button.getAttribute("aria-controls")).toBe(LOCAL_PANEL_ID);
    expect(shown()).toBe(SITE_FLIGHTS_MESSAGE);
    // How to name the files, rather than the zone's words once more;
    // the regions are there from the start, empty, as a live region must be
    expect(status().textContent).toBe("");
    expect(status().hidden).toBe(false);
    expect(alert().hidden).toBe(false);
    expect(alert().textContent).toBe("");
    const hint = panel().querySelector(".local-flights-hint")!;
    expect(hint.textContent).toContain("1_DEAGJ_DA20.kml");
    expect(hint.querySelector("a")?.getAttribute("rel")).toBe("noopener");
  });

  it("names the file field by the label's text that is shown (WCAG 2.5.3)", () => {
    makePanel();

    const input =
      panel().querySelector<HTMLInputElement>('input[type="file"]')!;
    // A name of its own would not be what a voice command says
    expect(input.hasAttribute("aria-label")).toBe(false);
    expect(input.closest("label")!.textContent).toContain(
      "Drop KML or KMZ files here, or choose files",
    );
    expect(input.closest("label")!.textContent).toContain(
      "Choose KML or KMZ files",
    );
  });

  it("lands in the body without a main", () => {
    document.querySelector("main")!.remove();
    const local = makePanel();

    expect(local.panel.parentElement).toBe(document.body);
  });

  it("opens with the focus on its close button and the button expanded", async () => {
    button.focus();
    const local = makePanel();

    local.open();
    await settle();

    expect(local.isOpen()).toBe(true);
    expect(document.activeElement).toBe(closeButton());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.classList.contains("active")).toBe(true);
    expect(store.listFiles).toHaveBeenCalledTimes(1);
    expect(store.readInfo).toHaveBeenCalledTimes(1);
  });

  it("closes to a control that is shown, where the button is not", async () => {
    // A phone: the column with the button is hidden, the More tab is not
    const more = document.createElement("button");
    more.id = "mobile-tab-more";
    document.body.append(more);
    button.focus();
    button.checkVisibility = () => false;
    const local = makePanel();
    local.open();
    await settle();

    local.close();

    expect(document.activeElement).toBe(more);
  });

  it("closes back to the button, which is no longer active", async () => {
    button.focus();
    const local = makePanel();
    local.open();
    await settle();

    local.close();

    expect(local.isOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.classList.contains("active")).toBe(false);
  });

  it("stays active on close while the page shows the visitor's flights", async () => {
    store.readInfo.mockResolvedValue(INFO);
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    local.close();

    expect(button.classList.contains("active")).toBe(true);
  });

  it("leaves the focus where it is when the panel did not have it", async () => {
    const local = makePanel();
    local.open();
    await settle();
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();

    local.close();

    expect(document.activeElement).toBe(other);
  });

  it("closes once; a second close is nothing", () => {
    const local = makePanel();
    local.open();
    local.close();
    local.close();

    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles", () => {
    const local = makePanel();

    local.toggle();
    expect(local.isOpen()).toBe(true);
    local.toggle();
    expect(local.isOpen()).toBe(false);
  });

  it("closes on Escape and on its close button", () => {
    const local = makePanel();
    local.open();
    panel().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(local.isOpen()).toBe(false);

    // The page's Escape, wherever the focus is, but not one a text field
    // of the page or a listener before took
    local.open();
    const field = document.createElement("input");
    document.body.append(field);
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(local.isOpen()).toBe(true);
    const taken = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    taken.preventDefault();
    document.body.dispatchEvent(taken);
    expect(local.isOpen()).toBe(true);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(local.isOpen()).toBe(false);

    local.open();
    closeButton().click();
    expect(local.isOpen()).toBe(false);
  });

  it("closes on a pointer down outside, not on one inside or on its button", () => {
    const local = makePanel();
    const down = (target: EventTarget) =>
      target.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    local.open();
    down(closeButton());
    expect(local.isOpen()).toBe(true);
    down(button);
    expect(local.isOpen()).toBe(true);
    down(document.body);
    expect(local.isOpen()).toBe(false);
  });

  it("stands beside the button where the button is shown", () => {
    const local = makePanel();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      top: 100.4,
      right: 60.2,
      width: 50,
    } as DOMRect);

    local.open();

    expect(local.panel.classList.contains("is-anchored")).toBe(true);
    expect(local.panel.style.getPropertyValue("--local-left")).toBe("68px");
    expect(local.panel.style.getPropertyValue("--local-top")).toBe("100px");
  });

  it("spans the top where the button is hidden, and follows the window", () => {
    const local = makePanel();
    local.open();
    expect(local.panel.classList.contains("is-anchored")).toBe(false);

    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      top: 10,
      right: 20,
      width: 50,
    } as DOMRect);
    window.dispatchEvent(new Event("resize"));
    expect(local.panel.classList.contains("is-anchored")).toBe(true);

    local.close();
    window.dispatchEvent(new Event("resize"));
    // Not measured while closed
    expect(local.panel.classList.contains("is-anchored")).toBe(true);
  });

  it("is placed again as the statistics panel comes and goes", () => {
    const frames = stubAnimationFrames();
    const local = makePanel();
    local.open();
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      top: 10,
      right: 20,
      width: 50,
    } as DOMRect);

    app.statsPanelVisible = true;
    frames.run();

    expect(local.panel.classList.contains("is-anchored")).toBe(true);
  });

  it("goes with the app", () => {
    const controller = new AbortController();
    const local = makePanel({ signal: controller.signal });

    controller.abort();

    expect(local.panel.isConnected).toBe(false);
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("the files kept", () => {
  it("are listed with their sizes and a Remove each", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 2048), stored("b.kmz")]);
    const local = makePanel();
    local.open();
    await settle();

    expect(names()).toEqual(["a.kml", "b.kmz"]);
    expect(
      Array.from(
        panel().querySelectorAll(".local-flights-size"),
        (size) => size.textContent,
      ),
    ).toEqual(["2.0 KB", "3 B"]);
    expect(
      panel().querySelector<HTMLElement>("[data-remove]")?.dataset["remove"],
    ).toBe("a.kml");
    expect(status().textContent).toBe("");
    expect(action("show").hidden).toBe(false);
    expect(action("site").hidden).toBe(true);
    expect(action("clear").hidden).toBe(false);
  });

  it("offers neither Show nor Remove all without any", async () => {
    const local = makePanel();
    local.open();
    await settle();

    expect(action("show").hidden).toBe(true);
    expect(action("clear").hidden).toBe(true);
    expect(status().textContent).toBe("");
  });

  it("says so when the store cannot be read", async () => {
    store.listFiles.mockRejectedValue(new Error("no idb"));
    const local = makePanel();
    local.open();
    await settle();

    expect(alert().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(alert().textContent).not.toBe("");
    expect(logError).toHaveBeenCalled();
  });

  it("marks the files the last build left out, and shows its warnings", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({
      ...INFO,
      skipped: [{ file: "b.kml", reason: "no track with a <year>" }],
      warnings: ["1 file(s) name no aircraft (a.kml)"],
    });
    await openPanel();

    const items = panel().querySelectorAll(".local-flights-files li");
    expect(items[0]!.classList.contains("is-skipped")).toBe(false);
    expect(items[1]!.classList.contains("is-skipped")).toBe(true);
    expect(items[1]!.querySelector(".local-flights-reason")?.textContent).toBe(
      "Left out: no track with a <year>",
    );
    const warnings = panel().querySelector<HTMLElement>(
      ".local-flights-warnings",
    )!;
    expect(warnings.hidden).toBe(false);
    expect(warnings.textContent).toBe("1 file(s) name no aircraft (a.kml)");
  });

  it("escapes a file name in the list", async () => {
    store.listFiles.mockResolvedValue([stored('<b>"x".kml')]);
    const local = makePanel();
    local.open();
    await settle();

    expect(names()).toEqual(['<b>"x".kml']);
    expect(panel().querySelector("b")).toBeNull();
  });
});

describe("adding files", () => {
  it("refuses what is no KML, KMZ or aircraft.json, and keeps the rest", async () => {
    const local = makePanel();

    await local.add([file("notes.txt")]);

    expect(alert().textContent).toBe(UNSUPPORTED_FILES_MESSAGE);
    expect(alert().textContent).not.toBe("");
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(fake.build).not.toHaveBeenCalled();
  });

  it("keeps the accepted files, asks for persistence and builds them", async () => {
    // As kept, of the sizes dropped: none replaced another
    store.listFiles.mockResolvedValue([
      stored("1.KMZ", 6),
      stored("aircraft.json", 2),
    ]);
    const local = await openPanel();
    localStorage.setItem(LOCAL_STATE_KEY, "{}");

    const dropped = file("1.KMZ");
    const adding = local.add([
      dropped,
      file("photo.jpg"),
      file("aircraft.json", "{}"),
    ]);
    await settle();
    await settle();

    // The aircraft file as kept stays as it is, and builds with the rest
    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual(["1.KMZ"]);
    // A copy of its bytes, not the File: Chrome's incognito windows and
    // Safari would keep a reference to the file on the disk
    expect(kept[0]!.bytes).not.toBe(dropped);
    expect(kept[0]!.bytes).toBeInstanceOf(Blob);
    await expect(kept[0]!.bytes.text()).resolves.toBe(await dropped.text());
    expect(store.requestPersistence).toHaveBeenCalledTimes(1);
    // The refusal of the photo is still said as the build goes on
    expect(alert().textContent).toBe(UNSUPPORTED_FILES_MESSAGE);
    expect(status().textContent).toBe(BUILDING_MESSAGE);
    expect(action("show").hidden).toBe(true);
    expect(fake.build).toHaveBeenCalledTimes(1);
    const [inputs, terrain, , options] = fake.build.mock
      .calls[0]! as unknown as [
      { name: string; bytes: Blob }[],
      boolean,
      unknown,
      { flags: unknown; version: unknown },
    ];
    expect(terrain).toBe(true);
    // No flags where the site's metadata could not be read
    expect(options).toEqual({
      flags: undefined,
      version: undefined,
      retry: false,
    });
    expect(inputs.map((i) => i.name)).toEqual(["1.KMZ", "aircraft.json"]);
    // The bytes are read from the store by name, as Blobs the worker
    // reads; the aircraft file kept first, to tell the one dropped by
    expect(
      (store.readFileBytes.mock.calls as [string][]).map(([name]) => name),
    ).toEqual(["aircraft.json", "1.KMZ", "aircraft.json"]);
    await expect(inputs[0]!.bytes.text()).resolves.toBe("1.KMZ");

    fake.settlers[0]!.progress("  Parsing 1 KML file(s)...");
    expect(status().textContent).toBe("Parsing 1 KML file(s)...");
    fake.settlers[0]!.progress("   ");
    expect(status().textContent).toBe(BUILDING_MESSAGE);

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    expect(store.putDataset).toHaveBeenCalledWith(
      OUTCOME.files,
      expect.objectContaining({
        years: [2025],
        flights: 1,
        airports: 2,
        bounds: OUTCOME.bounds,
        files: ["1.KMZ", "aircraft.json"],
        stamp: fileStamp([stored("1.KMZ", 6), stored("aircraft.json", 2)]),
        build: undefined,
        skipped: [],
        warnings: [],
        terrain: true,
      }),
    );
    expect(status().textContent).toBe(BUILT_MESSAGE);
    // The state saved for the last dataset is of flights gone
    expect(app.stateManager.cancelSave).toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_STATE_KEY)).toBeNull();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    expect(sessionStorage.getItem(REOPEN_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("takes the files of the picker and of a drop on the zone", () => {
    const local = makePanel();
    const add = vi.spyOn(local, "add").mockResolvedValue(undefined);
    const input = panel().querySelector<HTMLInputElement>("input")!;
    // The list of a file input is live, and clearing the field empties it,
    // which the field is cleared for the next pick: what was picked has to
    // be copied before
    const picked = [file("a.kml")];
    Object.defineProperty(input, "files", {
      get: () => picked,
      configurable: true,
    });
    Object.defineProperty(input, "value", {
      set: (value: string) => {
        if (value === "") picked.length = 0;
      },
      configurable: true,
    });

    input.dispatchEvent(new Event("change"));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ name: "a.kml" }),
    ]);
    expect(input.files).toHaveLength(0);

    const zone = panel().querySelector<HTMLElement>(".local-flights-drop")!;
    const over = new Event("dragover", { cancelable: true });
    zone.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(zone.classList.contains("is-over")).toBe(true);
    zone.dispatchEvent(new Event("dragleave"));
    expect(zone.classList.contains("is-over")).toBe(false);

    const dropped = [file("b.kml")];
    const drop = new Event("drop", {
      cancelable: true,
      bubbles: true,
    }) as Event & {
      dataTransfer: unknown;
    };
    drop.dataTransfer = { files: dropped };
    // It goes on up to the window, taken: the watch there leaves a drop
    // the zone took (ui/fileDropWatch.ts), and the sheet over the map
    // hides on it (ui/fileDrop.ts)
    const onWindow = vi.fn<(event: Event) => void>();
    window.addEventListener("drop", onWindow, { once: true });
    zone.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(add).toHaveBeenLastCalledWith(dropped);
    expect(onWindow).toHaveBeenCalledTimes(1);
    expect(onWindow.mock.calls[0]![0].defaultPrevented).toBe(true);
    window.removeEventListener("drop", onWindow);

    // An empty drop and an empty pick add nothing
    const empty = new Event("drop", { cancelable: true }) as Event & {
      dataTransfer: unknown;
    };
    empty.dataTransfer = { files: [] };
    zone.dispatchEvent(empty);
    input.dispatchEvent(new Event("change"));
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("builds without a file whose bytes went from the store meanwhile", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readFileBytes.mockImplementation((name: string) =>
      Promise.resolve(name === "a.kml" ? new Blob(["a"]) : null),
    );
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    const [inputs] = fake.build.mock.calls[0]! as unknown as [
      { name: string }[],
    ];
    expect(inputs.map((i) => i.name)).toEqual(["a.kml"]);
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("says so when the files cannot be kept", async () => {
    store.putFiles.mockRejectedValue(new Error("quota"));
    const local = makePanel();

    await local.add([file("a.kml")]);

    expect(alert().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(fake.build).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalled();
  });

  it("shows a failed build as an error and stays on the site's flights", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    fake.settlers[0]!.reject(new Error("1 of 1 file(s) failed to parse"));
    await adding;

    expect(alert().textContent).toBe("1 of 1 file(s) failed to parse");
    expect(status().textContent).toBe("");
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    // The files are still there to try again with
    expect(action("show").hidden).toBe(false);
  });

  it("says a failure that is no Error as it is", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    fake.settlers[0]!.reject("boom" as unknown as Error);
    await adding;

    expect(alert().textContent).toBe("boom");
  });

  it("builds once more after a build that files arrived during", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const first = local.add([file("a.kml")]);
    await settle();
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const second = local.add([file("b.kml")]);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();

    fake.settlers[1]!.resolve(OUTCOME);
    await Promise.all([first, second]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.putDataset).toHaveBeenLastCalledWith(
      OUTCOME.files,
      expect.objectContaining({ files: ["a.kml", "b.kml"] }),
    );
  });

  it("records the files it built, not the ones that arrived meanwhile", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const first = local.add([file("a.kml")]);
    await settle();
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const second = local.add([file("b.kml")]);
    await settle();

    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    expect(store.putDataset).toHaveBeenLastCalledWith(
      OUTCOME.files,
      expect.objectContaining({ files: ["a.kml"] }),
    );

    fake.settlers[1]!.resolve(OUTCOME);
    await Promise.all([first, second]);
    expect(store.putDataset).toHaveBeenLastCalledWith(
      OUTCOME.files,
      expect.objectContaining({ files: ["a.kml", "b.kml"] }),
    );
  });

  it("drops what a build made of files removed while it ran", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();
    const adding = local.add([file("a.kml")]);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    store.listFiles.mockResolvedValue([]);
    removeAll();
    await settle();
    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    // Said to the other tabs, which may show them (reopenAfterSwitch)
    expect(localStorage.getItem(REMOVED_KEY)).not.toBeNull();

    // The lines of the build still going are not the panel's any more
    fake.settlers[0]!.progress("Parsing 1 KML file(s)...");
    expect(status().textContent).toBe(REMOVED_MESSAGE);

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
    expect(store.putDataset).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    // And the panel is as the Remove all left it
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    expect(action("show").hidden).toBe(true);
  });

  it("says nothing of the build a Remove all let go of", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    store.listFiles.mockResolvedValue([]);
    removeAll();
    // The worker went with it, and its build with the worker's failure
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await adding;
    await settle();

    expect(alert().textContent).toBe("");
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    expect(logError).not.toHaveBeenCalled();
  });

  it("starts no build of the files a Remove all took while they were read", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    let read!: (bytes: Blob) => void;
    store.readFileBytes.mockReturnValue(
      new Promise<Blob>((resolve) => {
        read = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    store.listFiles.mockResolvedValue([]);
    removeAll();
    await settle();
    read(new Blob(["a"]));
    await adding;
    await settle();

    // A build would start a worker, with a cache of the files removed
    expect(fake.build).not.toHaveBeenCalled();
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    expect(alert().textContent).toBe("");
  });

  it("keeps files dropped during a Remove all once it is done, not before", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    let deleted!: () => void;
    // Another tab holds the cache a while
    store.deleteCache.mockReturnValue(
      new Promise<void>((resolve) => {
        deleted = resolve;
      }),
    );
    const local = await openPanel();

    removeAll();
    await settle();
    const adding = local.add([file("b.kml")]);
    await settle();
    expect(store.putFiles).not.toHaveBeenCalled();

    store.listFiles.mockResolvedValue([stored("b.kml", 6)]);
    deleted();
    await settle();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(store.putFiles).toHaveBeenCalledTimes(1);
    expect(store.clearAll.mock.invocationCallOrder[0]).toBeLessThan(
      store.putFiles.mock.invocationCallOrder[0]!,
    );
    expect(fake.build).toHaveBeenCalledTimes(1);
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("says a file dropped again with other contents replaced the one kept", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 3), stored("b.kml", 6)]);
    const local = await openPanel();

    // b.kml again as it was, a.kml of another flight under the same name
    const adding = local.add([file("a.kml"), file("b.kml")]);
    await settle();

    expect(alert().textContent).toBe(replacedMessage(["a.kml"]));
    expect(replacedMessage(["a.kml"])).toBe(
      "a.kml replaced a file of the same name",
    );
    expect(replacedMessage(["a.kml", "b.kml"])).toBe(
      "a.kml, b.kml replaced files of the same name",
    );
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  /** A file of `size` bytes, which are never read but for the first */
  const sized = (name: string, size: number): File =>
    ({
      name,
      size,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
    }) as unknown as File;

  it("refuses files that would take the files kept past the limit in all", async () => {
    // Every build takes all of them: a drop under the limit on its own
    store.listFiles.mockResolvedValue([
      stored("a.kml", MAX_KEPT_BYTES * 0.6),
      stored("b.kml", MAX_KEPT_BYTES / 4),
    ]);
    const local = makePanel();

    await local.add([sized("c.kml", MAX_FILE_BYTES)]);

    expect(alert().textContent).toBe(TOO_LARGE_MESSAGE);
    expect(store.putFiles).not.toHaveBeenCalled();

    // One dropped again in place of a larger one kept comes to less
    const adding = local.add([sized("a.kml", MAX_FILE_BYTES)]);
    await settle();
    expect(store.putFiles).toHaveBeenCalledTimes(1);
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("refuses a file larger than the build reads, and keeps the rest", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    const local = makePanel();

    const adding = local.add([
      sized("huge.kml", MAX_FILE_BYTES + 1),
      file("a.kml"),
    ]);
    await settle();

    expect(alert().textContent).toBe(oversizedMessage(["huge.kml"]));
    expect(oversizedMessage(["a.kml", "b.kml"])).toBe(
      "a.kml, b.kml are larger than 32 MB, which the build in the browser cannot read",
    );
    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual(["a.kml"]);
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("says the storage is full when the browser's quota is used up", async () => {
    store.putFiles.mockRejectedValue(
      new DOMException("full", "QuotaExceededError"),
    );
    const local = makePanel();

    await local.add([file("a.kml")]);

    expect(alert().textContent).toBe(STORAGE_FULL_MESSAGE);
    expect(fake.build).not.toHaveBeenCalled();
  });

  it("says the storage is full when the dataset does not fit", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.putDataset.mockRejectedValue(
      new DOMException("full", "QuotaExceededError"),
    );
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    expect(alert().textContent).toBe(STORAGE_FULL_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("takes the files of a folder dropped, and leaves out what else is in it", async () => {
    const entry = (name: string, content = "<kml/>") => ({
      name,
      isDirectory: false,
      isFile: true,
      file: (resolve: (file: File) => void) => resolve(file(name, content)),
    });
    /** A folder whose reader hands its entries out in parts, as Chrome's */
    const folder = (name: string, ...parts: unknown[][]) => ({
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => {
        const left = [...parts, []];
        return {
          readEntries: (resolve: (entries: unknown[]) => void) =>
            resolve(left.shift()!),
        };
      },
    });
    const broken = {
      name: "locked",
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (_: unknown, reject: (error: Error) => void) =>
          reject(new Error("NotReadableError")),
      }),
    };
    store.listFiles.mockResolvedValue([stored("1.kml", 6)]);
    const local = makePanel();

    const adding = local.add([
      folder(
        "flights",
        [entry("1.kml"), entry(".DS_Store")],
        [folder("2025", [entry("2.KMZ"), entry("notes.txt")]), broken],
      ),
      entry("aircraft.json", "{}"),
    ] as unknown as FileSystemEntry[]);
    await settle();
    await settle();
    await settle();

    // The files dropped before the folders, each folder's before those in it
    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual([
      "aircraft.json",
      "1.kml",
      "2.KMZ",
    ]);
    // What the folder holds besides is no mistake; what it could not read is
    expect(alert().textContent).toBe(unreadableMessage(["locked"]));
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("keeps every aircraft.json of a drop, numbered, and no AppleDouble file", async () => {
    const entry = (name: string, content = "{}") => ({
      name,
      isDirectory: false,
      isFile: true,
      file: (resolve: (file: File) => void) => resolve(file(name, content)),
    });
    const folder = (name: string, ...entries: unknown[]) => ({
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => {
        const left = [entries, []];
        return {
          readEntries: (resolve: (entries: unknown[]) => void) =>
            resolve(left.shift()!),
        };
      },
    });
    store.listFiles.mockResolvedValue([stored("1.kml", 6)]);
    const local = makePanel();

    // A folder from a foreign disk on macOS, with ._ files beside each; the
    // folder in it listed first, as a browser may
    // And its .git, which the site build leaves out too: not even read
    const git = folder(".git", entry("2.kml", "<kml/>"));
    const readGit = vi.spyOn(git, "createReader");
    const adding = local.add([
      folder(
        "logs",
        folder(
          "2025",
          entry("1.kml", "<kml/>"),
          entry("._1.kml", "\u0000\u0005"),
          entry("aircraft.json", '{"D-EAGJ": {}}'),
        ),
        git,
        entry("aircraft.json"),
        entry("._aircraft.json"),
      ),
    ] as unknown as FileSystemEntry[]);
    await settle();
    await settle();
    await settle();

    // The one nearest the flights numbered last, which the build lets win
    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => [f.name, f.size])).toEqual([
      [aircraftName(1), 2],
      ["1.kml", 6],
      [aircraftName(2), 14],
    ]);
    expect(aircraftName(1)).toBe("aircraft.json");
    expect(aircraftName(2)).toBe("aircraft-2.json");
    expect(readGit).not.toHaveBeenCalled();
    // Neither is a mistake of the visitor's
    expect(alert().textContent).toBe("");
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("numbers an aircraft.json on from those kept, and leaves one dropped again as it is", async () => {
    store.listFiles.mockResolvedValue([
      stored("aircraft.json", 2),
      stored("aircraft-3.json", 5),
      stored("1.kml", 6),
    ]);
    const local = makePanel();

    // The first as kept, the second changed since: it wins over the others;
    // the third of the size of one kept, but another (a model renamed)
    const adding = local.add([
      file("aircraft.json", "{}"),
      file("aircraft.json", '{"D-EAGJ": {}}'),
      file("aircraft.json", "[]"),
    ]);
    await settle();
    await settle();

    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual([
      "aircraft-4.json",
      "aircraft-5.json",
    ]);
    // None replaced a file of another size, nor took the place of another
    expect(alert().textContent).toBe("");
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("keeps no file dropped again as it is kept, and shows the flights instead", async () => {
    const dropped = Object.assign(file("1.kml"), {});
    store.listFiles.mockResolvedValue([
      { ...stored("1.kml", dropped.size), modified: dropped.lastModified },
      stored("2.kml", 6),
    ]);
    store.readInfo.mockResolvedValue({
      ...INFO,
      files: ["1.kml", "2.kml"],
      stamp: fileStamp([
        { ...stored("1.kml", dropped.size), modified: dropped.lastModified },
        stored("2.kml", 6),
      ]),
    });
    const local = makePanel();

    await local.add([dropped]);

    // Neither written again nor built: shown as they are
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(fake.build).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
  });

  it("builds no file dropped again as it is kept while a build of it runs", async () => {
    const dropped = file("1.kml");
    store.listFiles.mockResolvedValue([
      { ...stored("1.kml", dropped.size), modified: dropped.lastModified },
    ]);
    const local = makePanel();
    const first = local.add([file("2.kml")]);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    // The build on its way has it already, and shows it once done
    await local.add([dropped]);
    fake.settlers[0]!.resolve(OUTCOME);
    await first;
    await settle();

    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(store.putFiles).toHaveBeenCalledTimes(1);
  });

  it("keeps a file dropped again that changed since, with its time", async () => {
    const changed = file("1.kml");
    store.listFiles.mockResolvedValue([
      { ...stored("1.kml", changed.size), modified: changed.lastModified - 1 },
    ]);
    const local = makePanel();

    const adding = local.add([changed]);
    await settle();

    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => [f.name, f.modified])).toEqual([
      ["1.kml", changed.lastModified],
    ]);
    expect(fake.build).toHaveBeenCalledTimes(1);
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("tells an aircraft file kept by its number", () => {
    expect(aircraftNumber("aircraft.json")).toBe(1);
    expect(aircraftNumber("aircraft-12.json")).toBe(12);
    expect(aircraftNumber("aircraft-2.kml")).toBe(0);
    expect(aircraftNumber("1_DEAGJ_DA20.KMZ")).toBe(0);
  });

  it("leaves the AppleDouble files out of what is picked or dropped loose", async () => {
    store.listFiles.mockResolvedValue([stored("1.kml", 6)]);
    const local = makePanel();

    const adding = local.add([file("._1.kml", "\u0000\u0005"), file("1.kml")]);
    await settle();

    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual(["1.kml"]);
    expect(alert().textContent).toBe("");
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    // Alone, it is no file to show, not one refused
    store.putFiles.mockClear();
    await local.add([file("._2.kml")]);
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(alert().textContent).toBe(NO_FILES_MESSAGE);
  });

  it("keeps the first of files of one name in different folders, and says so", async () => {
    const entry = (name: string, content: string) => ({
      name,
      isDirectory: false,
      isFile: true,
      file: (resolve: (file: File) => void) => resolve(file(name, content)),
    });
    const folder = (name: string, ...entries: unknown[]) => ({
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => {
        const left = [entries, []];
        return {
          readEntries: (resolve: (entries: unknown[]) => void) =>
            resolve(left.shift()!),
        };
      },
    });
    store.listFiles.mockResolvedValue([stored("1.kml", 6)]);
    const local = makePanel();

    // Numbered names that start again every year
    const adding = local.add([
      folder(
        "logs",
        folder("2025", entry("1.kml", "<kml/>")),
        folder("2026", entry("1.kml", "<kml></kml>")),
      ),
    ] as unknown as FileSystemEntry[]);
    await settle();
    await settle();
    await settle();

    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => [f.name, f.size])).toEqual([["1.kml", 6]]);
    expect(alert().textContent).toBe(duplicateMessage(["1.kml"]));
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("says a drop with nothing the build takes in it found nothing", async () => {
    const local = makePanel();
    const folder = {
      name: "igc",
      isDirectory: true,
      isFile: false,
      createReader: () => {
        const left = [
          [
            {
              name: "flight.igc",
              isDirectory: false,
              isFile: true,
              file: (resolve: (file: File) => void) =>
                resolve(file("flight.igc")),
            },
          ],
          [],
        ];
        return {
          readEntries: (resolve: (entries: unknown[]) => void) =>
            resolve(left.shift()!),
        };
      },
    };

    await local.add([folder] as unknown as FileSystemEntry[]);

    expect(alert().textContent).toBe(NO_FILES_MESSAGE);
    expect(status().textContent).toBe("");
    expect(store.putFiles).not.toHaveBeenCalled();
  });

  it("checks two drops at once against the limit one after the other", async () => {
    // What is kept grows with each drop kept
    const kept: StoredFile[] = [stored("z.kml", MAX_KEPT_BYTES * 0.7)];
    store.listFiles.mockImplementation(() => Promise.resolve([...kept]));
    store.putFiles.mockImplementation((files: StoredFileWithBytes[]) => {
      kept.push(
        ...files.map(({ name, size, added }) => ({ name, size, added })),
      );
      return Promise.resolve();
    });
    const local = makePanel();

    const first = local.add([sized("a.kml", MAX_FILE_BYTES)]);
    const second = local.add([sized("b.kml", MAX_FILE_BYTES)]);
    await settle();
    await settle();

    expect(store.putFiles).toHaveBeenCalledTimes(1);
    expect(kept.map((f) => f.name)).toEqual(["z.kml", "a.kml"]);
    expect(alert().textContent).toBe(TOO_LARGE_MESSAGE);
    fake.settlers[0]!.resolve(OUTCOME);
    await Promise.all([first, second]);
  });

  it("builds again after a failure that files arrived during", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const first = local.add([file("a.kml")]);
    await settle();
    const second = local.add([file("b.kml")]);
    await settle();

    fake.settlers[0]!.reject(new Error("bad"));
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(2);
    fake.settlers[1]!.resolve(OUTCOME);
    await Promise.all([first, second]);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says which files it could not read, and keeps the rest", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    const local = makePanel();
    const gone = {
      name: "cloud.kml",
      size: 3,
      arrayBuffer: () => Promise.reject(new Error("NotReadableError")),
    } as unknown as File;

    const adding = local.add([gone, file("a.kml")]);
    await settle();

    expect(alert().textContent).toBe(unreadableMessage(["cloud.kml"]));
    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual(["a.kml"]);
    expect(logError).toHaveBeenCalled();
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("says the flights are ready rather than reload with the panel closed", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    expect(store.putDataset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    const toast = document.querySelector<HTMLElement>(
      `.toast-notification[data-message="${READY_MESSAGE}"]`,
    )!;
    toast.querySelector<HTMLButtonElement>(".toast-button")!.click();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("says the flights are ready rather than reload under a replay", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    app.replayActive = true;

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    expect(reload).not.toHaveBeenCalled();
    expect(status().textContent).toBe(READY_MESSAGE);
  });

  it("builds without the ground where asked to, and keeps the choice", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    await openPanel();
    const box = panel().querySelector<HTMLInputElement>(
      ".local-flights-terrain input",
    )!;
    expect(box.checked).toBe(false);

    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();

    // Built again at once, the files being there
    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(fake.build.mock.calls[0]![1]).toBe(false);
    expect(localStorage.getItem(NO_TERRAIN_KEY)).toBe("1");
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    expect(store.putDataset).toHaveBeenLastCalledWith(
      OUTCOME.files,
      expect.objectContaining({ terrain: false }),
    );
    // A setting does not take the page to flights it did not show
    expect(reload).not.toHaveBeenCalled();
    expect(status().textContent).toBe(READY_MESSAGE);
    // And the next panel starts with it
    makePanel();
    expect(
      panel().querySelector<HTMLInputElement>(".local-flights-terrain input")!
        .checked,
    ).toBe(true);
  });

  it("builds without the ground where asked to though the browser keeps no choice", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const box = panel().querySelector<HTMLInputElement>(
      ".local-flights-terrain input",
    )!;
    // Its storage full, or refused: the choice stays for the page's lifetime
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
    try {
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      await settle();
      expect(fake.build.mock.calls[0]![1]).toBe(false);
      fake.settlers[0]!.resolve(OUTCOME);
      await settle();

      // Nor does a later build, or the panel read again, forget it
      const adding = local.add([file("b.kml")]);
      await settle();
      expect(fake.build.mock.calls[1]![1]).toBe(false);
      expect(box.checked).toBe(true);
      fake.settlers[1]!.resolve(OUTCOME);
      await adding;
    } finally {
      setItem.mockRestore();
      box.checked = false;
      box.dispatchEvent(new Event("change"));
      await settle();
    }
  });

  it("stops a build that fetches the ground once it is switched off, and builds without", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const box = panel().querySelector<HTMLInputElement>(
      ".local-flights-terrain input",
    )!;
    const adding = local.add([file("b.kml")]);
    await settle();
    expect(fake.build.mock.calls[0]![1]).toBe(true);

    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();

    // Let go of before it asks AWS for more tiles, and started again
    // without them
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(fake.build.mock.calls[1]![1]).toBe(false);
    // Which fails with the worker it went with, unsaid
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await settle();
    expect(alert().textContent).toBe("");
    fake.settlers[1]!.resolve(OUTCOME);
    await adding;
    await settle();
    expect(store.putDataset).toHaveBeenCalledTimes(1);
    expect(store.putDataset).toHaveBeenLastCalledWith(
      OUTCOME.files,
      expect.objectContaining({ terrain: false }),
    );
    // Shown, as the drop asked
    expect(reload).toHaveBeenCalledTimes(1);

    // Switched on again, nothing is stopped: the next build takes it
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(fake.build.mock.calls[2]![1]).toBe(true);
    fake.settlers[2]!.resolve(OUTCOME);
    await settle();
  });

  it("stops a build that fetches the ground once another tab switches it off", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const box = panel().querySelector<HTMLInputElement>(
      ".local-flights-terrain input",
    )!;
    const adding = local.add([file("b.kml")]);
    await settle();
    expect(fake.build.mock.calls[0]![1]).toBe(true);

    // Another tab's: the storage event of its choice
    localStorage.setItem(NO_TERRAIN_KEY, "1");
    window.dispatchEvent(
      new StorageEvent("storage", { key: NO_TERRAIN_KEY, newValue: "1" }),
    );
    await settle();

    expect(box.checked).toBe(true);
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(fake.build.mock.calls[1]![1]).toBe(false);
    fake.settlers[0]!.reject(new Error("The build could not run"));
    fake.settlers[1]!.resolve(OUTCOME);
    await adding;
    await settle();

    // Nor is a build without the ground stopped by the choice said again
    const again = local.add([file("c.kml")]);
    await settle();
    expect(fake.build.mock.calls[2]![1]).toBe(false);
    window.dispatchEvent(
      new StorageEvent("storage", { key: NO_TERRAIN_KEY, newValue: "1" }),
    );
    await settle();
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    fake.settlers[2]!.resolve(OUTCOME);
    await again;

    // Another key, or the choice undone, stops nothing
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    localStorage.removeItem(NO_TERRAIN_KEY);
    window.dispatchEvent(
      new StorageEvent("storage", { key: NO_TERRAIN_KEY, newValue: null }),
    );
    await settle();
    expect(box.checked).toBe(false);
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(fake.build).toHaveBeenCalledTimes(3);
  });

  it("builds without the ground when another tab asked for it, and says so", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const box = panel().querySelector<HTMLInputElement>(
      ".local-flights-terrain input",
    )!;
    expect(box.checked).toBe(false);
    // Ticked in another tab while this one was open
    localStorage.setItem(NO_TERRAIN_KEY, "1");

    const adding = local.add([file("b.kml")]);
    await settle();

    // No tile is asked of AWS
    expect(fake.build.mock.calls[0]![1]).toBe(false);
    expect(box.checked).toBe(true);
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    // And the box shows it as the panel opens again
    local.close();
    localStorage.removeItem(NO_TERRAIN_KEY);
    local.open();
    await settle();
    expect(box.checked).toBe(false);
  });

  it("hands the build the site's flags and its build", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ available_flags: ["de", 1, "fr"] })),
        ),
      ),
    );
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel({
      config: { dataDir: "site-data", generator: "abc" },
    });

    const adding = local.add([file("a.kml")]);
    await settle();
    await settle();

    // As the site's build, which a cached copy of another is not
    expect(fetch).toHaveBeenCalledWith(
      `site-data/metadata.json?v=${encodeURIComponent(siteBuild({ generator: "abc" })!)}`,
    );
    expect(fake.build.mock.calls[0]![3]).toEqual({
      flags: ["de", "fr"],
      version: siteBuild({ generator: "abc" }),
      retry: false,
    });
    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
  });

  it("hands the build the flags of the site's metadata the page loaded", async () => {
    siteData.metadata = {
      available_flags: ["nl"],
    } as unknown as NonNullable<typeof siteData.metadata>;
    try {
      store.listFiles.mockResolvedValue([stored("a.kml")]);
      const local = await openPanel();

      const adding = local.add([file("a.kml")]);
      await settle();
      await settle();

      expect(fetch).not.toHaveBeenCalled();
      expect(fake.build.mock.calls[0]![3]).toMatchObject({ flags: ["nl"] });
      fake.settlers[0]!.resolve(OUTCOME);
      await adding;
    } finally {
      siteData.metadata = null;
    }
  });
});

describe("removing a file", () => {
  it("builds the rest again", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const local = makePanel();
    local.open();
    await settle();
    store.listFiles.mockResolvedValue([stored("b.kml")]);

    panel().querySelector<HTMLElement>('[data-remove="a.kml"]')!.click();
    await settle();

    expect(store.removeFile).toHaveBeenCalledWith("a.kml");
    expect(names()).toEqual(["b.kml"]);
    expect(fake.build).toHaveBeenCalledTimes(1);
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    // The site's flights are shown: they stay, and the panel says the
    // visitor's are ready, with the way to them
    expect(store.putDataset).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(status().textContent).toBe(READY_MESSAGE);
    expect(action("show").hidden).toBe(false);
  });

  it("still shows the flights a drop asked for when a file goes while it is built", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    let read!: (bytes: Blob) => void;
    store.readFileBytes.mockReturnValueOnce(
      new Promise<Blob>((resolve) => {
        read = resolve;
      }),
    );
    let removed!: () => void;
    store.removeFile.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        removed = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("b.kml")]);
    await settle();

    // The build lets go of the files read as b.kml goes, before the
    // removal builds the rest
    panel().querySelector<HTMLElement>('[data-remove="b.kml"]')!.click();
    read(new Blob(["a"]));
    await adding;
    await settle();
    expect(fake.build).not.toHaveBeenCalled();
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    removed();
    await settle();

    expect(fake.build).toHaveBeenCalledTimes(1);
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("lets go of the build on its way, and builds the rest at once", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const local = await openPanel();
    const adding = local.add([file("b.kml")]);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    store.listFiles.mockResolvedValue([stored("a.kml")]);
    panel().querySelector<HTMLElement>('[data-remove="b.kml"]')!.click();
    await settle();

    // Not after the old one is done, asking AWS for the tiles under b.kml
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(fake.build.mock.calls[1]![0]).toEqual([
      expect.objectContaining({ name: "a.kml" }),
    ]);
    // What the old one says is not the panel's any more
    fake.settlers[0]!.progress("Parsing 2 KML file(s)...");
    expect(status().textContent).toBe(BUILDING_MESSAGE);
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await adding;
    await settle();
    expect(alert().textContent).toBe("");

    // And the drop's flights are still shown, as it asked
    fake.settlers[1]!.resolve(OUTCOME);
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the flag through a rebuild a removal let go of, whose build goes on", async () => {
    // The rebuild a start asked for (reopenAfterSwitch), of another deploy
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
    const local = await openPanel();
    const rebuilding = local.rebuild();
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    store.listFiles.mockResolvedValue([stored("a.kml")]);
    panel().querySelector<HTMLElement>('[data-remove="b.kml"]')!.click();
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await settle();

    // Not given up on: the build without the file is on its way, and a
    // closed panel only says it is ready, which the next visit opens on
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    local.close();
    fake.settlers[1]!.resolve(OUTCOME);
    await rebuilding;
    await settle();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
  });

  it("lets the flag go as the build a removal asked for in a rebuild fails or is stopped", async () => {
    for (const end of ["fails", "stopped"]) {
      localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
      store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
      store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
      const local = await openPanel();
      const rebuilding = local.rebuild();
      await settle();
      store.listFiles.mockResolvedValue([stored("a.kml")]);
      panel().querySelector<HTMLElement>('[data-remove="b.kml"]')!.click();
      fake.settlers[0]!.reject(new Error("The build could not run"));
      await settle();
      expect(fake.build).toHaveBeenCalledTimes(2);

      // As the rebuild's own would: the next visit opens on the site's
      // flights rather than building them again on its own
      if (end === "fails") {
        fake.settlers[1]!.reject(new Error("No valid KML files to process!"));
      } else {
        action("cancel").click();
        fake.settlers[1]!.reject(new Error("The build could not run"));
      }
      await rebuilding;
      expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
      local.destroy();
    }
  });

  it("lets the flag go as a Remove all lets go of a rebuild", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
    const local = await openPanel();
    const rebuilding = local.rebuild();
    await settle();

    removeAll();
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await rebuilding;
    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    // Not left for the files dropped next, which the next visit would
    // open on unasked
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
  });

  it("shows the rest built again where the visitor's flights are shown", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();
    store.listFiles.mockResolvedValue([stored("b.kml")]);

    panel().querySelector<HTMLElement>('[data-remove="a.kml"]')!.click();
    await settle();
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
  });

  it("keeps the focus on the next Remove, or on the file field after the last", async () => {
    store.listFiles.mockResolvedValue([
      stored("a.kml"),
      stored("b.kml"),
      stored("c.kml"),
    ]);
    const local = makePanel();
    local.open();
    await settle();
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("c.kml")]);

    const second = panel().querySelector<HTMLElement>('[data-remove="b.kml"]')!;
    second.focus();
    second.click();
    await settle();

    expect(document.activeElement).toBe(
      panel().querySelector('[data-remove="c.kml"]'),
    );
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();

    // The last one goes with everything else
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const last = panel().querySelector<HTMLElement>('[data-remove="c.kml"]')!;
    last.click();
    await settle();
    expect(document.activeElement).toBe(
      panel().querySelector('[data-remove="a.kml"]'),
    );
    fake.settlers[1]!.resolve(OUTCOME);
    await settle();
    store.listFiles.mockResolvedValue([]);
    panel().querySelector<HTMLElement>('[data-remove="a.kml"]')!.click();
    await settle();
    expect(document.activeElement).toBe(panel().querySelector("input"));
  });

  it("the last one clears everything and says so", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();
    store.listFiles.mockResolvedValue([]);

    panel().querySelector<HTMLElement>('[data-remove="a.kml"]')!.click();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(store.deleteCache).toHaveBeenCalledTimes(1);
    expect(fake.build).not.toHaveBeenCalled();
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("says so when the store refuses", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.removeFile.mockRejectedValue(new Error("locked"));
    const local = makePanel();
    local.open();
    await settle();

    panel().querySelector<HTMLElement>('[data-remove="a.kml"]')!.click();
    await settle();

    expect(alert().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(fake.build).not.toHaveBeenCalled();
  });

  it("builds the files again when a removal during a build fails", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    // The build is dropped for the file going, which then stays
    store.removeFile.mockRejectedValueOnce(new Error("locked"));
    panel().querySelector<HTMLElement>('[data-remove="b.kml"]')!.click();
    await settle();
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();

    expect(alert().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(fake.build).toHaveBeenCalledTimes(2);
    // And it still shows them, as the drop asked
    fake.settlers[1]!.resolve(OUTCOME);
    await adding;
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores a click in the list that is on no Remove", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();

    panel().querySelector<HTMLElement>(".local-flights-name")!.click();
    await settle();

    expect(store.removeFile).not.toHaveBeenCalled();
  });
});

describe("a build on its way", () => {
  it("is stopped on asking, the files kept, and Show my flights back", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    const local = await openPanel();
    expect(action("cancel").hidden).toBe(true);
    const adding = local.add([file("a.kml")]);
    await settle();
    expect(action("cancel").hidden).toBe(false);
    expect(action("show").hidden).toBe(true);

    action("cancel").focus();
    action("cancel").click();

    // The worker goes with it, and its build with the worker's failure
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe(CANCELLED_MESSAGE);
    expect(action("cancel").hidden).toBe(true);
    expect(action("show").hidden).toBe(false);
    expect(document.activeElement).toBe(action("show"));
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await adding;
    expect(alert().textContent).toBe("");
    expect(status().textContent).toBe(CANCELLED_MESSAGE);
    expect(store.putDataset).not.toHaveBeenCalled();
    expect(store.clearAll).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    // Kept for the next visit, which then builds nothing on its own
    expect(localStorage.getItem(STOPPED_KEY)).toBe("1");

    // Until the next build
    action("show").click();
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(STOPPED_KEY)).toBeNull();
  });

  it("offers Show my flights after a stop where the visitor's flights are shown", async () => {
    // The dataset shown is of a.kml and b.kml, and c.kml was dropped
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    const local = await openPanel({ config: { localFlights: INFO } });
    expect(action("show").hidden).toBe(true);
    store.listFiles.mockResolvedValue([
      stored("a.kml"),
      stored("b.kml"),
      stored("c.kml", 6),
    ]);
    const adding = local.add([file("c.kml")]);
    await settle();

    action("cancel").click();
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await adding;

    // The flights shown are not of the files kept: Show builds them
    expect(action("show").hidden).toBe(false);
    action("show").click();
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(2);
  });

  it("offers Show my flights for a dataset newer than the one shown", async () => {
    // Of the same files, built while the panel was closed: only a toast
    // said it was ready
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, builtAt: 2 });
    await openPanel({ config: { localFlights: INFO } });

    expect(action("show").hidden).toBe(false);
    action("show").click();
    await settle();
    expect(fake.build).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is let go of as the panel is torn down, with none after it", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();
    const rebuilding = local.rebuild();
    await settle();
    // A drop meanwhile asks for another build after it
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    const adding = local.add([file("b.kml")]);
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);

    local.destroy();
    fake.settlers[0]!.reject(new Error("The build could not run"));
    await Promise.all([rebuilding, adding]);
    await settle();

    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalledWith(
      "The build of the flights failed:",
      expect.anything(),
    );
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("builds no drop it was keeping as the panel was torn down", async () => {
    let stored_!: () => void;
    store.putFiles.mockReturnValue(
      new Promise<void>((resolve) => {
        stored_ = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    local.destroy();
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    stored_();
    await adding;
    await settle();

    expect(fake.build).not.toHaveBeenCalled();
  });

  it("cannot be stopped once its dataset is being kept", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    let kept!: () => void;
    store.putDataset.mockReturnValue(
      new Promise<void>((resolve) => {
        kept = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    expect(action("cancel").hidden).toBe(false);
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();

    expect(action("cancel").hidden).toBe(true);
    action("cancel").click();
    expect(fake.builder.destroy).not.toHaveBeenCalled();
    kept();
    await adding;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("starts no worker when stopped while the files are read", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    let read!: (bytes: Blob) => void;
    store.readFileBytes.mockReturnValue(
      new Promise<Blob>((resolve) => {
        read = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    action("cancel").click();
    read(new Blob(["a"]));
    await adding;

    expect(fake.build).not.toHaveBeenCalled();
    expect(status().textContent).toBe(CANCELLED_MESSAGE);
  });

  it("moves the focus to Stop the build as Show my flights hides", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    await openPanel();
    action("show").focus();

    action("show").click();
    await settle();

    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(action("cancel"));
  });

  it("does not come back as the flights a Remove all made while it was kept", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    let kept!: () => void;
    store.putDataset.mockReturnValue(
      new Promise<void>((resolve) => {
        kept = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    expect(store.putDataset).toHaveBeenCalledTimes(1);

    store.listFiles.mockResolvedValue([]);
    removeAll();
    await settle();
    kept();
    await adding;
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(status().textContent).toBe(REMOVED_MESSAGE);
  });

  it("builds again rather than show a dataset of a file removed while it was kept", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    let kept!: () => void;
    store.putDataset.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        kept = resolve;
      }),
    );
    const local = await openPanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();

    store.listFiles.mockResolvedValue([stored("b.kml")]);
    panel().querySelector<HTMLElement>('[data-remove="a.kml"]')!.click();
    await settle();
    kept();
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(fake.build).toHaveBeenCalledTimes(2);
    // The drop asked for the flights to be shown, which the build of the
    // rest still does
    fake.settlers[1]!.resolve(OUTCOME);
    await adding;
    await settle();
    expect(store.putDataset).toHaveBeenLastCalledWith(
      OUTCOME.files,
      expect.objectContaining({ files: ["b.kml"] }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("Remove all", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks to be pressed again, and lets go of the ask after a while", async () => {
    vi.useFakeTimers();
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();

    action("clear").click();
    await settle();
    expect(action("clear").textContent).toBe(CONFIRM_CLEAR_LABEL);
    expect(store.deleteCache).not.toHaveBeenCalled();
    expect(store.clearAll).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CONFIRM_CLEAR_MS - 1);
    expect(action("clear").textContent).toBe(CONFIRM_CLEAR_LABEL);
    await vi.advanceTimersByTimeAsync(1);
    expect(action("clear").textContent).toBe("Remove all");
    // Said, as the question was
    expect(status().textContent).toBe(CONFIRM_LAPSED_MESSAGE);
    action("clear").click();
    await settle();
    expect(store.clearAll).not.toHaveBeenCalled();

    action("clear").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(action("clear").textContent).toBe("Remove all");
  });
});

describe("Remove all, with the focus on it", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for as long as the button has the focus", async () => {
    vi.useFakeTimers();
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();

    action("clear").focus();
    action("clear").click();
    await vi.advanceTimersByTimeAsync(CONFIRM_CLEAR_MS * 3);
    expect(action("clear").textContent).toBe(CONFIRM_CLEAR_LABEL);
    expect(status().textContent).toBe(CONFIRM_CLEAR_MESSAGE);

    // And no longer than the wait after the focus moved on
    closeButton().focus();
    await vi.advanceTimersByTimeAsync(CONFIRM_CLEAR_MS);
    expect(action("clear").textContent).toBe("Remove all");
    expect(status().textContent).toBe(CONFIRM_LAPSED_MESSAGE);
  });
});

describe("Remove all, asking", () => {
  it("lets go of the ask as the panel closes", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();

    action("clear").click();
    expect(action("clear").textContent).toBe(CONFIRM_CLEAR_LABEL);
    local.close();
    local.open();
    await settle();

    expect(action("clear").textContent).toBe("Remove all");
    action("clear").click();
    await settle();
    expect(store.clearAll).not.toHaveBeenCalled();
  });

  it("says what it asks in the status, and lets go of it", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = await openPanel();

    action("clear").click();
    expect(status().textContent).toBe(CONFIRM_CLEAR_MESSAGE);
    local.close();
    expect(status().textContent).toBe("");
  });

  it("hides Stop the build at once, and offers Show my flights when the files stay", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    let cleared!: (error: Error) => void;
    store.deleteCache.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        cleared = reject;
      }),
    );
    const local = await openPanel();
    void local.add([file("a.kml")]);
    await settle();
    expect(action("cancel").hidden).toBe(false);

    removeAll();
    // Another tab holds the cache: it waits
    expect(action("cancel").hidden).toBe(true);
    cleared(new Error(CACHE_BUSY_MESSAGE));
    await settle();

    expect(alert().textContent).toBe(CACHE_BUSY_MESSAGE);
    expect(action("cancel").hidden).toBe(true);
    expect(action("show").hidden).toBe(false);
  });

  it("takes a double-click for one press", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    await openPanel();

    action("clear").dispatchEvent(new MouseEvent("click", { detail: 1 }));
    action("clear").dispatchEvent(new MouseEvent("click", { detail: 2 }));
    await settle();

    expect(action("clear").textContent).toBe(CONFIRM_CLEAR_LABEL);
    expect(store.clearAll).not.toHaveBeenCalled();
  });

  it("takes a slow double-click for one press too", async () => {
    vi.useFakeTimers();
    try {
      store.listFiles.mockResolvedValue([stored("a.kml")]);
      const local = makePanel();
      local.open();
      await vi.advanceTimersByTimeAsync(0);

      action("clear").dispatchEvent(new MouseEvent("click", { detail: 1 }));
      // Within the 500 ms of the systems' double-click time, past 400
      await vi.advanceTimersByTimeAsync(450);
      action("clear").dispatchEvent(new MouseEvent("click", { detail: 2 }));
      await vi.advanceTimersByTimeAsync(0);

      expect(store.clearAll).not.toHaveBeenCalled();
      expect(action("clear").textContent).toBe(CONFIRM_CLEAR_LABEL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a triple-click for one press", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    await openPanel();

    for (const detail of [1, 2, 3]) {
      action("clear").dispatchEvent(new MouseEvent("click", { detail }));
    }
    await settle();

    expect(store.clearAll).not.toHaveBeenCalled();
  });

  it("takes a press after it, however quick the clicks", async () => {
    vi.useFakeTimers();
    try {
      store.listFiles.mockResolvedValue([stored("a.kml")]);
      const local = makePanel();
      local.open();
      await vi.advanceTimersByTimeAsync(0);

      action("clear").dispatchEvent(new MouseEvent("click", { detail: 1 }));
      await vi.advanceTimersByTimeAsync(600);
      // The third of quick clicks, one press of its own
      action("clear").dispatchEvent(new MouseEvent("click", { detail: 3 }));
      await vi.advanceTimersByTimeAsync(0);

      expect(store.clearAll).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("upToDate", () => {
  const files = [stored("a.kml"), stored("b.kml")];

  it("is the dataset of exactly these files, by this build", () => {
    expect(upToDate(INFO, files)).toBe(true);
    expect(upToDate(INFO, [files[1]!, files[0]!])).toBe(true);
    expect(upToDate(null, files)).toBe(false);
  });

  it("is not with a file more, fewer, larger or dropped again", () => {
    expect(upToDate(INFO, [files[0]!])).toBe(false);
    expect(upToDate(INFO, [...files, stored("c.kml")])).toBe(false);
    expect(upToDate(INFO, [stored("a.kml", 4), files[1]!])).toBe(false);
    expect(upToDate(INFO, [{ ...stored("a.kml"), added: 2 }, files[1]!])).toBe(
      false,
    );
  });

  it("is not for a dataset of another build of the site", () => {
    expect(upToDate({ ...INFO, build: "0123456789ab" }, files)).toBe(false);
  });

  it("is not for a dataset built with the ground when it is not wanted, or the other way", () => {
    expect(upToDate({ ...INFO, terrain: true }, files)).toBe(true);
    expect(upToDate({ ...INFO, terrain: false }, files)).toBe(false);
    localStorage.setItem(NO_TERRAIN_KEY, "1");
    expect(upToDate({ ...INFO, terrain: false }, files)).toBe(true);
    // A dataset from before the choice was built with the ground
    expect(upToDate(INFO, files)).toBe(false);
  });

  it("is not for a dataset of another Python, whose frontend is the same", () => {
    // A deploy that changed only the Python changes the generator alone
    const built = { ...INFO, build: siteBuild({ generator: "one" }) };
    expect(upToDate(built, files, { generator: "one" })).toBe(true);
    expect(upToDate(built, files, { generator: "two" })).toBe(false);
  });
});

describe("Build again", () => {
  const DEGRADED: LocalInfo = { ...INFO, degraded: ["airports", "terrain"] };

  it("is offered for a dataset built without what could not be fetched", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(DEGRADED);
    const local = makePanel({ config: { localFlights: DEGRADED } });
    local.open();
    await settle();

    expect(action("again").hidden).toBe(false);
    expect(action("again").textContent).toBe(BUILD_AGAIN_LABEL);
    expect(action("again").title).toBe(degradedMessage(DEGRADED.degraded!));
    // The dataset is what was asked for: nothing is built by itself
    expect(fake.build).not.toHaveBeenCalled();

    action("again").click();
    await settle();
    expect(fake.build).toHaveBeenCalledTimes(1);
    // Downloaded again at once, which a failed download holds back else
    expect(fake.build.mock.calls[0]![3]).toMatchObject({ retry: true });
    expect(action("again").hidden).toBe(true);
    fake.settlers[0]!.resolve(OUTCOME);
    await settle();
    await settle();
    // Built with everything this time: the page goes to it
    expect(store.putDataset).toHaveBeenCalledWith(
      OUTCOME.files,
      expect.objectContaining({ degraded: [] }),
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("is not offered for a dataset with everything", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, degraded: [] });
    const local = makePanel();
    local.open();
    await settle();

    expect(action("again").hidden).toBe(true);
  });

  it("keeps what the build went without with the dataset", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();

    // A build of its own waits out a failed download, a slow line its timeout
    expect(fake.build.mock.calls[0]![3]).toMatchObject({ retry: false });
    fake.settlers[0]!.resolve({ ...OUTCOME, degraded: ["terrain"] });
    await adding;

    expect(store.putDataset).toHaveBeenCalledWith(
      OUTCOME.files,
      expect.objectContaining({ degraded: ["terrain"] }),
    );
  });

  it("is offered once a tab as the page starts on such a dataset", async () => {
    const config = { config: { localFlights: DEGRADED } };
    const said = (): HTMLElement | null =>
      document.querySelector<HTMLElement>(
        `.toast-notification[data-message="${degradedMessage(DEGRADED.degraded!)}"]`,
      );
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(DEGRADED);
    const started = asMapApp(createMockApp(config));

    // The panel the toast opens is the page's, with a builder of its own
    const build = vi
      .spyOn(LocalBuilder.prototype, "build")
      .mockReturnValue(new Promise<BuildOutcome>(() => {}));

    reopenAfterSwitch(started);
    const toast = said()!;
    const again = toast.querySelector<HTMLButtonElement>(".toast-button")!;
    expect(again.textContent).toBe(BUILD_AGAIN_LABEL);
    again.click();
    await settle();
    await settle();

    expect(panel().hidden).toBe(false);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]![3]).toMatchObject({ retry: true });
    build.mockRestore();
    toast.remove();
    reopenAfterSwitch(asMapApp(createMockApp(config)));
    expect(said()).toBeNull();
  });

  it("is not built again from the toast while the map is held, which keeps it", async () => {
    sessionStorage.clear();
    const mock = createMockApp({ config: { localFlights: DEGRADED } });
    const build = vi
      .spyOn(LocalBuilder.prototype, "build")
      .mockReturnValue(new Promise<BuildOutcome>(() => {}));
    reopenAfterSwitch(asMapApp(mock));
    const toast = document.querySelector<HTMLElement>(
      `.toast-notification[data-message="${degradedMessage(DEGRADED.degraded!)}"]`,
    )!;
    toast.classList.add("toast-visible");
    mock.replayActive = true;

    toast.querySelector<HTMLButtonElement>(".toast-button")!.click();
    await settle();

    expect(build).not.toHaveBeenCalled();
    expect(toast.classList.contains("toast-visible")).toBe(true);
    build.mockRestore();
  });
});

describe("a build that fails", () => {
  it("says so with a toast while the panel is closed, with the way to it", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    local.close();

    fake.settlers[0]!.reject(new Error("No valid KML files to process!"));
    await adding;

    expect(alert().textContent).toBe("No valid KML files to process!");
    const toast = document.querySelector<HTMLElement>(
      '.toast-notification.toast-error[data-message="No valid KML files to process!"]',
    )!;
    toast.querySelector<HTMLButtonElement>(".toast-button")!.click();
    expect(local.isOpen()).toBe(true);
  });

  it("says so in the panel alone while it is open", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    const adding = local.add([file("a.kml")]);
    await settle();

    fake.settlers[0]!.reject(new Error("No valid KML files to process!"));
    await adding;

    expect(alert().textContent).toBe("No valid KML files to process!");
    expect(document.querySelector(".toast-error")).toBeNull();
  });

  it("reads the files again when another tab removed them", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    const adding = local.add([file("a.kml")]);
    await settle();
    store.listFiles.mockResolvedValue([]);

    fake.settlers[0]!.reject(new Error(CACHE_GONE_MESSAGE));
    await adding;

    expect(alert().textContent).toBe(CACHE_GONE_MESSAGE);
    expect(names()).toEqual([]);
  });

  it("builds again, saying nothing, when another tab let go of the cache and not of the files", async () => {
    // That tab's Remove all could not remove them: a third held them
    store.listFiles.mockResolvedValue([stored("a.kml", 6)]);
    const local = makePanel();
    local.open();
    const adding = local.add([file("a.kml")]);
    await settle();

    fake.settlers[0]!.reject(new Error(CACHE_GONE_MESSAGE));
    await settle();

    expect(alert().textContent).toBe("");
    expect(fake.build).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe(BUILDING_MESSAGE);
    // And shows them as the first would have
    fake.settlers[1]!.resolve(OUTCOME);
    await adding;
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing it built when another tab removed the files meanwhile", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    const adding = local.add([file("a.kml")]);
    await settle();
    // Its Python ran before the cache went: done, but the files are gone
    store.putDataset.mockRejectedValue(new Error(CACHE_GONE_MESSAGE));
    store.listFiles.mockResolvedValue([]);

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;

    expect(alert().textContent).toBe(CACHE_GONE_MESSAGE);
    expect(names()).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(fake.build).toHaveBeenCalledTimes(1);
  });

  it("keeps its toast while the map is held, whose Show cannot open the panel", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    const adding = local.add([file("a.kml")]);
    await settle();
    app.replayActive = true;

    fake.settlers[0]!.reject(new Error("No valid KML files to process!"));
    await adding;

    const toast = document.querySelector<HTMLElement>(
      '.toast-notification.toast-error[data-message="No valid KML files to process!"]',
    )!;
    // Shown, as the next frame makes it; a toast taken away loses the class
    toast.classList.add("toast-visible");
    toast.querySelector<HTMLButtonElement>(".toast-button")!.click();
    expect(local.isOpen()).toBe(false);
    expect(toast.classList.contains("toast-visible")).toBe(true);
    app.replayActive = false;
    toast.querySelector<HTMLButtonElement>(".toast-button")!.click();
    expect(local.isOpen()).toBe(true);
  });
});

describe("Show my flights", () => {
  it("switches without a build when the dataset is of the files kept", async () => {
    store.listFiles.mockResolvedValue([stored("b.kml"), stored("a.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    const local = makePanel();
    local.open();
    await settle();

    action("show").click();
    await settle();

    expect(fake.build).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("builds first when the files changed since", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    const local = makePanel();
    local.open();
    await settle();

    action("show").click();
    await settle();

    expect(fake.build).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it("builds when there is no dataset yet", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();

    action("show").click();
    await settle();

    expect(fake.build).toHaveBeenCalledTimes(1);
  });

  it("does nothing without files", async () => {
    const local = makePanel();
    local.open();
    await settle();

    action("show").click();
    await settle();

    expect(fake.build).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("while the page shows the visitor's flights", () => {
  it("says so, and offers the site's flights and Remove all", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    expect(shown()).toBe("Showing your 3 flights from 2 files");
    expect(action("show").hidden).toBe(true);
    expect(action("site").hidden).toBe(false);
    expect(action("clear").hidden).toBe(false);
  });

  it("goes back to the site's flights, keeping the files", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    action("site").click();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(sessionStorage.getItem(REOPEN_KEY)).toBe("1");
    expect(store.clearAll).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Remove all lets everything go and reloads on the site's flights", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    // The view, year and aircraft saved for the flights go too
    localStorage.setItem(LOCAL_STATE_KEY, "{}");
    store.readInfo.mockResolvedValue(INFO);
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    removeAll();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    // And the worker's cache, with the parsed tracks in it, once the
    // worker that holds it open is gone
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(store.deleteCache).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(localStorage.getItem(LOCAL_STATE_KEY)).toBeNull();
    expect(app.stateManager.cancelSave).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Remove all says so when the cache cannot be let go of", async () => {
    store.deleteCache.mockRejectedValue(new Error("in use"));
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    removeAll();
    await settle();

    // The cache goes first: the files are kept, to try again with
    expect(store.clearAll).not.toHaveBeenCalled();
    expect(alert().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("Remove all on the site's flights only says so", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();

    removeAll();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(names()).toEqual([]);
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    expect(action("clear").hidden).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("Remove all says another tab holds the files, and removes nothing", async () => {
    store.deleteCache.mockRejectedValue(new Error(CACHE_BUSY_MESSAGE));
    const local = await openPanel({ config: { localFlights: INFO } });

    removeAll();
    await settle();

    expect(alert().textContent).toBe(CACHE_BUSY_MESSAGE);
    expect(store.clearAll).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(local.isOpen()).toBe(true);
  });

  it("Remove all says so when the store refuses", async () => {
    store.clearAll.mockRejectedValue(new Error("locked"));
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    removeAll();
    await settle();

    expect(alert().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("the ask to reopen is kept for the page's lifetime when there is no session storage", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key) => {
        if (key === REOPEN_KEY) throw new Error("no storage");
      });
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    action("site").click();

    expect(reload).toHaveBeenCalledTimes(1);
    setItem.mockRestore();
  });
});

describe("toggleLocalFlights", () => {
  it("opens and closes one panel per app", () => {
    const app1 = asMapApp(createMockApp());

    toggleLocalFlights(app1);
    const first = panel();
    expect(first.hidden).toBe(false);
    toggleLocalFlights(app1);
    expect(first.hidden).toBe(true);
    toggleLocalFlights(app1);
    expect(panel()).toBe(first);
  });

  it("replaces the panel for another app", () => {
    toggleLocalFlights(asMapApp(createMockApp()));
    const first = panel();

    toggleLocalFlights(asMapApp(createMockApp()));

    expect(first.isConnected).toBe(false);
    expect(panel()).not.toBe(first);
    expect(panel().hidden).toBe(false);
  });

  it("does not open while the map is held, but closes", () => {
    const held = createMockApp();
    held.replayActive = true;

    toggleLocalFlights(asMapApp(held));
    expect(document.getElementById(LOCAL_PANEL_ID)?.hidden).toBe(true);

    held.replayActive = false;
    toggleLocalFlights(asMapApp(held));
    expect(panel().hidden).toBe(false);
    held.replayActive = true;
    toggleLocalFlights(asMapApp(held));
    expect(panel().hidden).toBe(true);
  });

  it("opens with dropped files, held map or not, and adds them", async () => {
    const held = createMockApp();
    held.replayActive = true;
    const dropped = [file("notes.txt")];

    toggleLocalFlights(asMapApp(held), dropped);
    await settle();

    expect(panel().hidden).toBe(false);
    expect(alert().textContent).toBe(UNSUPPORTED_FILES_MESSAGE);

    // Open already: the files are added, the panel stays open
    toggleLocalFlights(asMapApp(held), dropped);
    expect(panel().hidden).toBe(false);
  });

  it("refuses a drop while Wrapped is open, which would hold the panel inert", async () => {
    const app = createMockApp();
    app.wrappedVisible = true;

    toggleLocalFlights(asMapApp(app), [file("a.kml")]);
    await settle();

    expect(document.getElementById(LOCAL_PANEL_ID)?.hidden ?? true).toBe(true);
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        `.toast-notification[data-message="${DROP_IN_WRAPPED_MESSAGE}"]`,
      ),
    ).not.toBeNull();
  });
});

describe("in a page another frames", () => {
  // A page of another site that lures the visitor's clicks onto the frame
  beforeEach(() => {
    vi.spyOn(window, "parent", "get").mockReturnValue({} as Window);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not open, with dropped files or without, and says why", async () => {
    toggleLocalFlights(asMapApp(createMockApp()));
    toggleLocalFlights(asMapApp(createMockApp()), [file("a.kml")]);
    await settle();

    expect(document.getElementById(LOCAL_PANEL_ID)).toBeNull();
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(
      document.querySelector(
        `.toast-notification[data-message="${FRAMED_MESSAGE}"]`,
      ),
    ).not.toBeNull();
  });

  it("starts on the site's flights, and keeps the flag for the site itself", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    sessionStorage.setItem(REOPEN_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    try {
      await expect(
        localStartConfig({
          bounds: [
            [0, 0],
            [3, 3],
          ],
          dataDir: "data",
        }),
      ).resolves.toBeNull();
      reopenAfterSwitch(asMapApp(createMockApp()));

      expect(store.readInfo).not.toHaveBeenCalled();
      expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
      expect(document.getElementById(LOCAL_PANEL_ID)).toBeNull();
    } finally {
      localStorage.removeItem(LOCAL_FLIGHTS_KEY);
      sessionStorage.removeItem(REOPEN_KEY);
    }
  });
});

describe("localStartConfig", () => {
  const config = {
    center: [1, 2] as [number, number],
    bounds: [
      [0, 0],
      [3, 3],
    ] as [[number, number], [number, number]],
    dataDir: "data",
  };

  it("is null without a dataset, and clears the flag", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    // Saved again by a tab that showed them after another removed them
    localStorage.setItem(LOCAL_STATE_KEY, "{}");

    await expect(localStartConfig(config)).resolves.toBeNull();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(localStorage.getItem(LOCAL_STATE_KEY)).toBeNull();
  });

  it("is null for a dataset of another build of the site, which the panel builds again", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
    // A worker that never answers: the build stays on its way
    vi.stubGlobal(
      "Worker",
      class {
        onmessage = null;
        onerror = null;
        postMessage(): void {}
        terminate(): void {}
      },
    );

    await expect(localStartConfig(config)).resolves.toBeNull();

    // Kept: the page shows the visitor's flights as soon as they are built
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    expect(store.readDatasetFile).not.toHaveBeenCalled();
    reopenAfterSwitch(asMapApp(createMockApp()));
    await settle();
    expect(panel().hidden).toBe(false);
    expect(status().textContent).toBe(REBUILDING_MESSAGE);
    expect(store.readFileBytes).toHaveBeenCalledWith("a.kml");
  });

  it("lets the flag go when the build again fails, so the next visit opens on the site's", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
    // A worker that answers every build with a failure: offline, say
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onerror = null;
        postMessage(message: { id: number }): void {
          setTimeout(() =>
            this.onmessage?.({ data: { id: message.id, error: "offline" } }),
          );
        }
        terminate(): void {}
      },
    );
    await expect(localStartConfig(config)).resolves.toBeNull();

    reopenAfterSwitch(asMapApp(createMockApp()));
    await vi.waitFor(() => expect(alert().textContent).toBe("offline"));
    await settle();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    // And Show my flights tries again when asked to
    expect(action("show").hidden).toBe(false);
  });

  it("is null for a dataset of other files than the ones kept, which the panel builds again", async () => {
    // A file removed while the rebuild failed: the dataset still counts it
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.readInfo.mockResolvedValue(INFO);

    await expect(localStartConfig(config)).resolves.toBeNull();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    expect(store.readDatasetFile).not.toHaveBeenCalled();
    // Taken by the next start, which does not build again
    reopenAfterSwitch(asMapApp(createMockApp()));
    document.getElementById(LOCAL_PANEL_ID)?.remove();
  });

  it("opens on the flights built before when the visitor stopped the build of files added", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    localStorage.setItem(STOPPED_KEY, "1");
    store.listFiles.mockResolvedValue([
      stored("a.kml"),
      stored("b.kml"),
      stored("c.kml"),
    ]);
    store.readInfo.mockResolvedValue(INFO);

    const start = await localStartConfig(config);

    expect(start).toMatchObject({ localFlights: INFO });
    // Nothing built on its own; Show my flights builds the rest
    reopenAfterSwitch(asMapApp(createMockApp({ config: start! })));
    await settle();
    expect(document.getElementById(LOCAL_PANEL_ID)).toBeNull();
  });

  it("builds again after a stop when a file the dataset holds is gone, or another deploy built it", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    localStorage.setItem(STOPPED_KEY, "1");
    // b.kml removed: its flights would be shown again
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("c.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    await expect(localStartConfig(config)).resolves.toBeNull();

    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
    await expect(localStartConfig(config)).resolves.toBeNull();
    // Taken by the next start, which does not build again
    reopenAfterSwitch(asMapApp(createMockApp()));
    document.getElementById(LOCAL_PANEL_ID)?.remove();
  });

  it("says the files are built again, not the site updated, for other files of this build", async () => {
    // A build of a drop that was stopped
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    vi.stubGlobal(
      "Worker",
      class {
        onmessage = null;
        onerror = null;
        postMessage(): void {}
        terminate(): void {}
      },
    );

    await expect(localStartConfig(config)).resolves.toBeNull();
    reopenAfterSwitch(asMapApp(createMockApp()));
    await settle();

    expect(status().textContent).toBe(BUILDING_MESSAGE);
  });

  it("goes to a dataset built since the page started, rather than mix the two", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    store.readDatasetFile.mockResolvedValue(new ArrayBuffer(1));
    const reloadPage = vi.fn<() => void>();
    const start = await localStartConfig(config, reloadPage);
    await expect(
      start!.dataSource!.fetchBytes!(`${LOCAL_DATA_DIR}/2025/data.json`),
    ).resolves.toEqual(new ArrayBuffer(1));

    // The ready toast was left standing, and the page went on
    store.readInfo.mockResolvedValue({ ...INFO, builtAt: 2 });
    let settled = false;
    void start!.dataSource!.fetchBytes!(
      `${LOCAL_DATA_DIR}/2024/data.json`,
    ).then(() => {
      settled = true;
    });
    await settle();

    expect(reloadPage).toHaveBeenCalledTimes(1);
    // Nothing of the new dataset reaches the page that is going
    expect(settled).toBe(false);
  });

  it("is null for a link, and keeps the flag", async () => {
    // A long link someone copied: it is of the site's flights
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    history.replaceState(null, "", "/?y=2024&a=D-EAGJ");
    try {
      await expect(localStartConfig(config)).resolves.toBeNull();
      expect(store.readInfo).not.toHaveBeenCalled();
      expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");

      // In a tab that showed the visitor's flights before as well: the page
      // writes no state in its address there, so this one is a link too
      // (the long form a ?c= link is resolved to, reloaded)
      history.replaceState(null, "", "/");
      await expect(localStartConfig(config)).resolves.not.toBeNull();
      history.replaceState(null, "", "/?y=2024&a=D-EAGJ");
      await expect(localStartConfig(config)).resolves.toBeNull();

      // The debug switch is no link
      history.replaceState(null, "", "/?debug=true");
      await expect(localStartConfig(config)).resolves.not.toBeNull();
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("takes the state of a tab reloaded as it built the files again for its own, not for a link", async () => {
    // Another deploy built the dataset: the page shows the site's flights,
    // and writes their state in its address, while it builds them again
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });
    vi.stubGlobal(
      "Worker",
      class {
        onmessage = null;
        onerror = null;
        postMessage(): void {}
        terminate(): void {}
      },
    );
    try {
      await expect(localStartConfig(config)).resolves.toBeNull();
      const app = createMockApp();
      reopenAfterSwitch(asMapApp(app));
      await settle();
      // What a test before left to say (linkedAway)
      for (const toast of document.querySelectorAll(".toast-notification")) {
        toast.remove();
      }
      history.replaceState(null, "", "/?y=2024&a=D-EAGJ");
      window.dispatchEvent(new Event("pagehide"));
      expect(sessionStorage.getItem(REBUILT_ADDRESS_KEY)).toBe(
        "?y=2024&a=D-EAGJ",
      );

      // Reloaded: built again, with no word of a link, and the state goes
      // from the address, which would pick the year and the aircraft out
      // of the visitor's flights once built
      document.getElementById(LOCAL_PANEL_ID)?.remove();
      await expect(localStartConfig(config)).resolves.toBeNull();
      expect(location.search).toBe("");
      expect(sessionStorage.getItem(REBUILT_ADDRESS_KEY)).toBeNull();
      reopenAfterSwitch(asMapApp(createMockApp()));
      await settle();
      expect(status().textContent).toBe(REBUILDING_MESSAGE);
      expect(
        document.querySelector(
          `.toast-notification[data-message="${LINK_OPENED_SITE_MESSAGE}"]`,
        ),
      ).toBeNull();

      // Built by now: the visitor's flights, from the bare address
      store.readInfo.mockResolvedValue(INFO);
      sessionStorage.setItem(REBUILT_ADDRESS_KEY, "?y=2024&a=D-EAGJ");
      history.replaceState(null, "", "/?y=2024&a=D-EAGJ");
      await expect(localStartConfig(config)).resolves.not.toBeNull();
      expect(location.search).toBe("");
      // Keeping ?debug, which is no link
      sessionStorage.setItem(REBUILT_ADDRESS_KEY, "?y=2024&debug=true");
      history.replaceState(null, "", "/?y=2024&debug=true");
      await expect(localStartConfig(config)).resolves.not.toBeNull();
      expect(location.search).toBe("?debug=true");
      // Kept as it came: a value with "&" adds no parameter of its own
      sessionStorage.setItem(REBUILT_ADDRESS_KEY, "?y=2024&debug=a%26y%3D1");
      history.replaceState(null, "", "/?y=2024&debug=a%26y%3D1");
      await expect(localStartConfig(config)).resolves.not.toBeNull();
      expect(location.search).toBe("?debug=a%26y%3D1");

      // Another address in that tab is a link the visitor opened there
      sessionStorage.setItem(REBUILT_ADDRESS_KEY, "?y=2024&a=D-EAGJ");
      history.replaceState(null, "", "/?y=2023");
      const reads = store.readInfo.mock.calls.length;
      await expect(localStartConfig(config)).resolves.toBeNull();
      expect(location.search).toBe("?y=2023");
      expect(store.readInfo).toHaveBeenCalledTimes(reads);
      expect(sessionStorage.getItem(REBUILT_ADDRESS_KEY)).toBeNull();
      // Its toast, taken here
      reopenAfterSwitch(asMapApp(createMockApp()));
    } finally {
      history.replaceState(null, "", "/");
      sessionStorage.removeItem(REBUILT_ADDRESS_KEY);
    }
  });

  it("is null when the store cannot be read, with a log", async () => {
    store.readInfo.mockRejectedValue(new Error("no idb"));

    await expect(localStartConfig(config)).resolves.toBeNull();

    expect(logError).toHaveBeenCalled();
  });

  it("starts the page on the dataset in the browser", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue(INFO);
    store.readDatasetFile.mockImplementation((path: string) =>
      Promise.resolve(
        path === "metadata.json"
          ? new TextEncoder().encode('{"available_years":[2025]}').buffer
          : null,
      ),
    );

    const start = await localStartConfig(config);

    expect(start).toMatchObject({
      bounds: INFO.bounds,
      dataDir: LOCAL_DATA_DIR,
      localFlights: INFO,
    });
    await expect(
      start!.dataSource!.fetchJson!(`${LOCAL_DATA_DIR}/metadata.json`),
    ).resolves.toEqual({ available_years: [2025] });
    await expect(
      start!.dataSource!.fetchBytes!(`${LOCAL_DATA_DIR}/2025/data.json`),
    ).rejects.toThrow("Not in this browser: local/2025/data.json");
    // A path without the prefix is asked for as it is
    store.readDatasetFile.mockResolvedValueOnce(new ArrayBuffer(1));
    await expect(start!.dataSource!.fetchBytes!("x.json")).resolves.toEqual(
      new ArrayBuffer(1),
    );
    expect(store.readDatasetFile).toHaveBeenLastCalledWith("x.json");
  });
});

describe("reopenAfterSwitch", () => {
  it("opens the panel when it asked to be reopened, once", () => {
    sessionStorage.setItem(REOPEN_KEY, "1");
    const app1 = asMapApp(createMockApp());

    reopenAfterSwitch(app1);

    expect(panel().hidden).toBe(false);
    expect(sessionStorage.getItem(REOPEN_KEY)).toBeNull();
  });

  it("marks the button while the page shows the visitor's flights", () => {
    reopenAfterSwitch(
      asMapApp(createMockApp({ config: { localFlights: INFO } })),
    );

    expect(button.classList.contains("active")).toBe(true);
    expect(document.getElementById(LOCAL_PANEL_ID)).toBeNull();
  });

  it("lets the view of the flights another tab removed go, and shows the site's", () => {
    const mock = createMockApp({ config: { localFlights: INFO } });
    const showSite = vi.fn<() => void>();
    reopenAfterSwitch(asMapApp(mock), undefined, showSite);
    localStorage.setItem(LOCAL_STATE_KEY, "{}");

    // Another key, or the marker cleared: nothing
    window.dispatchEvent(
      new StorageEvent("storage", { key: LOCAL_FLIGHTS_KEY, newValue: null }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: REMOVED_KEY, newValue: null }),
    );
    expect(showSite).not.toHaveBeenCalled();

    window.dispatchEvent(
      new StorageEvent("storage", { key: REMOVED_KEY, newValue: "1" }),
    );
    expect(mock.stateManager.cancelSave).toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_STATE_KEY)).toBeNull();
    expect(showSite).toHaveBeenCalledTimes(1);
  });

  it("says Copy link cannot while the page shows the visitor's flights", () => {
    const controls = ["share-btn", "selection-link-btn"].map((id) => {
      const control = document.createElement("button");
      control.id = id;
      document.body.append(control);
      return control;
    });

    reopenAfterSwitch(
      asMapApp(createMockApp({ config: { localFlights: INFO } })),
    );

    for (const control of controls) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.title).toBe(
        "Links cannot carry flights that are only in this browser",
      );
    }
  });

  it("says a link opened the site's flights, with the way back to the visitor's", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    history.replaceState(null, "", "/?y=2024");
    try {
      await expect(
        localStartConfig({
          bounds: [
            [0, 0],
            [3, 3],
          ],
          dataDir: "data",
        }),
      ).resolves.toBeNull();
      const showMine = vi.fn();

      reopenAfterSwitch(asMapApp(createMockApp()), showMine);

      const toast = document.querySelector<HTMLElement>(
        `.toast-notification[data-message="${LINK_OPENED_SITE_MESSAGE}"]`,
      )!;
      const back = toast.querySelector<HTMLButtonElement>(".toast-button")!;
      expect(back.textContent).toBe("Show my flights");
      back.click();
      expect(showMine).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBe("1");
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("does nothing on the site's flights", () => {
    reopenAfterSwitch(asMapApp(createMockApp()));

    expect(button.classList.contains("active")).toBe(false);
    expect(document.getElementById(LOCAL_PANEL_ID)).toBeNull();
  });
});
