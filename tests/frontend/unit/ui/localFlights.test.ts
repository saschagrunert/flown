/**
 * Your flights (ui/localFlights.ts): the panel that takes the KML files a
 * visitor drops, keeps them in the browser, builds them in a worker and
 * reloads the page on what the build made. The store and the builder are
 * doubles here, and the reload a spy: a test reads what was kept, what was
 * built, which flag the next page starts from and whether it reloads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BUILDING_MESSAGE,
  BUILT_MESSAGE,
  LOCAL_BUTTON_ID,
  LOCAL_DATA_DIR,
  LOCAL_PANEL_ID,
  MAX_DROP_BYTES,
  TOO_LARGE_MESSAGE,
  LocalFlights,
  NO_FILES_MESSAGE,
  REMOVED_MESSAGE,
  SITE_FLIGHTS_MESSAGE,
  STORAGE_FAILED_MESSAGE,
  UNSUPPORTED_FILES_MESSAGE,
  localStartConfig,
  reopenAfterSwitch,
  shownMessage,
  toggleLocalFlights,
  upToDate,
} from "../../../../flown/frontend/ui/localFlights";
import {
  LOCAL_FLIGHTS_KEY,
  REOPEN_KEY,
} from "../../../../flown/frontend/state/localFlags";
import type {
  LocalBuilder,
  BuildOutcome,
} from "../../../../flown/frontend/services/localBuild";
import {
  fileStamp,
  type LocalInfo,
  type StoredFile,
  type StoredFileWithBytes,
} from "../../../../flown/frontend/services/localStore";
import { logError } from "../../../../flown/frontend/utils/logger";
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
  center: [51, 12],
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
  center: [51.3, 12.9],
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
  panel().querySelector<HTMLElement>(".local-flights-status")!;
const shown = (): string =>
  panel().querySelector(".local-flights-shown")!.textContent ?? "";
const action = (name: "show" | "site" | "clear"): HTMLButtonElement =>
  panel().querySelector<HTMLButtonElement>(`[data-local="${name}"]`)!;
const names = (): string[] =>
  Array.from(
    panel().querySelectorAll(".local-flights-name"),
    (name) => name.textContent ?? "",
  );
const closeButton = (): HTMLElement =>
  panel().querySelector<HTMLElement>(".local-flights-close")!;

/** Let the promise chains of the panel settle */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function makePanel(
  overrides: Parameters<typeof createMockApp>[0] = {},
): LocalFlights {
  app = createMockApp(overrides);
  fake = fakeBuilder();
  reload = vi.fn<() => void>();
  return new LocalFlights(asMapApp(app), fake.builder, reload);
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
  store.readFileBytes.mockImplementation((name: string) =>
    Promise.resolve(new TextEncoder().encode(name).buffer),
  );
  document.body.innerHTML = '<main><div id="map"></div></main>';
  button = document.createElement("button");
  button.id = LOCAL_BUTTON_ID;
  document.body.prepend(button);
});

afterEach(() => {
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
});

describe("the panel", () => {
  it("is made hidden ahead of the map, and points the button at itself", () => {
    const local = makePanel();

    expect(local.panel.hidden).toBe(true);
    expect(local.panel.nextElementSibling?.tagName).toBe("MAIN");
    expect(button.getAttribute("aria-controls")).toBe(LOCAL_PANEL_ID);
    expect(shown()).toBe(SITE_FLIGHTS_MESSAGE);
    expect(status().textContent).toBe(NO_FILES_MESSAGE);
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
    expect(status().hidden).toBe(true);
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
    expect(status().textContent).toBe(NO_FILES_MESSAGE);
  });

  it("says so when the store cannot be read", async () => {
    store.listFiles.mockRejectedValue(new Error("no idb"));
    const local = makePanel();
    local.open();
    await settle();

    expect(status().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(status().getAttribute("role")).toBe("alert");
    expect(logError).toHaveBeenCalled();
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

    expect(status().textContent).toBe(UNSUPPORTED_FILES_MESSAGE);
    expect(status().getAttribute("role")).toBe("alert");
    expect(store.putFiles).not.toHaveBeenCalled();
    expect(fake.build).not.toHaveBeenCalled();
  });

  it("keeps the accepted files, asks for persistence and builds them", async () => {
    const local = makePanel();
    store.listFiles.mockResolvedValue([
      stored("1.KMZ"),
      stored("aircraft.json"),
    ]);

    const adding = local.add([
      file("1.KMZ"),
      file("photo.jpg"),
      file("aircraft.json", "{}"),
    ]);
    await settle();

    const kept = store.putFiles.mock.calls[0]![0] as StoredFileWithBytes[];
    expect(kept.map((f) => f.name)).toEqual(["1.KMZ", "aircraft.json"]);
    expect(new TextDecoder().decode(kept[1]!.bytes)).toBe("{}");
    expect(kept[1]!.size).toBe(2);
    expect(store.requestPersistence).toHaveBeenCalledTimes(1);
    // The refusal of the photo was said, then the build took the line
    expect(status().textContent).toBe(BUILDING_MESSAGE);
    expect(action("show").hidden).toBe(true);
    expect(fake.build).toHaveBeenCalledTimes(1);
    const [inputs, terrain] = fake.build.mock.calls[0]! as unknown as [
      { name: string; bytes: ArrayBuffer }[],
      boolean,
    ];
    expect(terrain).toBe(true);
    expect(inputs.map((i) => i.name)).toEqual(["1.KMZ", "aircraft.json"]);
    // The bytes are read from the store by name: the build takes them
    // over, and the store keeps its own
    expect(
      (store.readFileBytes.mock.calls as [string][]).map(([name]) => name),
    ).toEqual(["1.KMZ", "aircraft.json"]);
    expect(new TextDecoder().decode(inputs[0]!.bytes)).toBe("1.KMZ");

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
        center: OUTCOME.center,
        bounds: OUTCOME.bounds,
        files: ["1.KMZ", "aircraft.json"],
        stamp: fileStamp([stored("1.KMZ"), stored("aircraft.json")]),
        build: undefined,
      }),
    );
    expect(status().textContent).toBe(BUILT_MESSAGE);
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
      Promise.resolve(name === "a.kml" ? new ArrayBuffer(1) : null),
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

    expect(status().textContent).toBe(STORAGE_FAILED_MESSAGE);
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

    expect(status().textContent).toBe("1 of 1 file(s) failed to parse");
    expect(status().getAttribute("role")).toBe("alert");
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

    expect(status().textContent).toBe("boom");
  });

  it("builds once more after a build that files arrived during", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
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
    action("clear").click();
    await settle();
    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe(REMOVED_MESSAGE);

    // The lines of the build still going are not the panel's any more
    fake.settlers[0]!.progress("Parsing 1 KML file(s)...");
    expect(status().textContent).toBe(REMOVED_MESSAGE);

    fake.settlers[0]!.resolve(OUTCOME);
    await adding;
    expect(store.putDataset).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    // And the panel asks for files again
    expect(status().textContent).toBe(NO_FILES_MESSAGE);
    expect(action("show").hidden).toBe(true);
  });

  it("refuses a drop of more than the limit at once", async () => {
    const local = makePanel();
    const big = {
      name: "big.kml",
      size: MAX_DROP_BYTES + 1,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as File;

    await local.add([big]);

    expect(status().textContent).toBe(TOO_LARGE_MESSAGE);
    expect(store.putFiles).not.toHaveBeenCalled();
  });

  it("builds again after a failure that files arrived during", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
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
    expect(reload).toHaveBeenCalledTimes(1);
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

    expect(status().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(fake.build).not.toHaveBeenCalled();
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
    store.readInfo.mockResolvedValue(INFO);
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    action("clear").click();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    // And the worker's cache, with the parsed tracks in it, once the
    // worker that holds it open is gone
    expect(fake.builder.destroy).toHaveBeenCalledTimes(1);
    expect(store.deleteCache).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Remove all says so when the cache cannot be let go of", async () => {
    store.deleteCache.mockRejectedValue(new Error("in use"));
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    action("clear").click();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe(STORAGE_FAILED_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it("Remove all on the site's flights only says so", async () => {
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    const local = makePanel();
    local.open();
    await settle();

    action("clear").click();
    await settle();

    expect(store.clearAll).toHaveBeenCalledTimes(1);
    expect(names()).toEqual([]);
    expect(status().textContent).toBe(REMOVED_MESSAGE);
    expect(action("clear").hidden).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("Remove all says so when the store refuses", async () => {
    store.clearAll.mockRejectedValue(new Error("locked"));
    const local = makePanel({ config: { localFlights: INFO } });
    local.open();
    await settle();

    action("clear").click();
    await settle();

    expect(status().textContent).toBe(STORAGE_FAILED_MESSAGE);
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
    expect(status().textContent).toBe(UNSUPPORTED_FILES_MESSAGE);

    // Open already: the files are added, the panel stays open
    toggleLocalFlights(asMapApp(held), dropped);
    expect(panel().hidden).toBe(false);
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

    await expect(localStartConfig(config)).resolves.toBeNull();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
  });

  it("is null for a dataset of another build of the site, and clears the flag", async () => {
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml"), stored("b.kml")]);
    store.readInfo.mockResolvedValue({ ...INFO, build: "0123456789ab" });

    await expect(localStartConfig(config)).resolves.toBeNull();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(store.readDatasetFile).not.toHaveBeenCalled();
  });

  it("is null for a dataset of other files than the ones kept, and clears the flag", async () => {
    // A file removed while the rebuild failed: the dataset still counts it
    localStorage.setItem(LOCAL_FLIGHTS_KEY, "1");
    store.listFiles.mockResolvedValue([stored("a.kml")]);
    store.readInfo.mockResolvedValue(INFO);

    await expect(localStartConfig(config)).resolves.toBeNull();

    expect(localStorage.getItem(LOCAL_FLIGHTS_KEY)).toBeNull();
    expect(store.readDatasetFile).not.toHaveBeenCalled();
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
      center: INFO.center,
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

  it("does nothing on the site's flights", () => {
    reopenAfterSwitch(asMapApp(createMockApp()));

    expect(button.classList.contains("active")).toBe(false);
    expect(document.getElementById(LOCAL_PANEL_ID)).toBeNull();
  });
});
