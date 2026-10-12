import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DataManager,
  heatmapPoints,
} from "../../../../flown/frontend/ui/dataManager";
import {
  heatLineFeatures,
  heatWeight,
  segmentSeconds,
} from "../../../../flown/frontend/calculations/heatLines";
import { heatLineTone } from "../../../../flown/frontend/calculations/heatTone";
import { flatCurves } from "../../../../flown/frontend/calculations/curves";
import { heatLinesSource } from "../../../../flown/frontend/services/flightLines";
import {
  exposedHeat,
  heatColumns,
  heatExposure,
} from "../../../../flown/frontend/calculations/heatExposure";
import { drawHeat } from "../../../../flown/frontend/services/heatSource";
import type { Coordinate } from "../../../../flown/frontend/utils/geometry";
import { logError } from "../../../../flown/frontend/utils/logger";
import {
  heatLinesPaint,
  heatmapPaint,
  HEATMAP_RADIUS_PX,
} from "../../../../flown/frontend/ui/heatmapPaint";
import {
  HEAT_LINES,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import {
  createExpression,
  type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { AVIATION_BAND } from "../../../../flown/frontend/mapLayers";
import { domCache } from "../../../../flown/frontend/utils/domCache";
import type {
  KMLDataset,
  LoadingState,
  PathSegment,
} from "../../../../flown/frontend/types";
import type { DataLoaderOptions } from "../../../../flown/frontend/services/dataLoader";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  stubAnimationFrames,
  type MockApp,
  type StubbedAnimationFrames,
} from "../../testHelpers";
import type { MockLayer, MockSource } from "../../../mocks/maplibre-gl";

const loaderMocks = vi.hoisted(() => ({
  loadData: vi.fn(),
  loadAirports: vi.fn(),
  loadMetadata: vi.fn(),
  cachedData: vi.fn(),
  destroy: vi.fn(),
  getDecoder: vi.fn(),
  options: null as DataLoaderOptions | null,
}));

vi.mock("../../../../flown/frontend/services/dataLoader", () => ({
  DataLoader: vi.fn(function (options: DataLoaderOptions) {
    loaderMocks.options = options;
    return {
      loadData: loaderMocks.loadData,
      loadAirports: loaderMocks.loadAirports,
      loadMetadata: loaderMocks.loadMetadata,
      cachedData: loaderMocks.cachedData,
      destroy: loaderMocks.destroy,
      getDecoder: loaderMocks.getDecoder,
    };
  }),
}));

vi.mock(
  import("../../../../flown/frontend/utils/logger"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    logError: vi.fn(),
  }),
);

/**
 * The year worker's part, done on the page and answered at once: the heat
 * drawn and the text of the sources written as the worker writes them
 * (services/heatSource.ts)
 */
const decoder = {
  drawHeat: vi.fn((points: readonly Coordinate[], weights: readonly number[]) =>
    Promise.resolve(drawHeat(heatColumns(points, weights))),
  ),
  heatLines: vi.fn(
    (
      segments: readonly PathSegment[],
      keep: ReadonlySet<number> | null,
      exposure: number,
    ) =>
      Promise.resolve(
        heatLinesSource(
          { segments, curves: flatCurves(segments) },
          { keep: keep && Float64Array.from(keep), exposure },
        ),
      ),
  ),
};

/**
 * A Blob that keeps its text at hand: jsdom's gives it back only
 * asynchronously, and a source is read at once here
 */
class TextBlob extends Blob {
  readonly json: string;
  constructor(parts: string[], options?: BlobPropertyBag) {
    super(parts, options);
    this.json = parts.join("");
  }
}

/** The text behind every Blob URL handed out and not let go of yet */
const blobUrls = new Map<string, string>();
let blobUrlCount = 0;

/**
 * Let the answers of the year worker, which the stand-in gives at once, be
 * taken in: they are promises, as the worker's are
 */
const answered = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  announceStatus: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../flown/frontend/utils/toast", () => toastMock);

/** A state of the loader, one year of unknown size unless said otherwise */
function loading(overrides: Partial<LoadingState> = {}): LoadingState {
  return {
    operation: 1,
    all: false,
    years: ["2026"],
    fileBytes: undefined,
    loadedBytes: 0,
    totalBytes: undefined,
    ...overrides,
  };
}

/** A position as the heat point source writes it, to 5 decimals (1.1 m) */
const degrees = (value: number): number => Math.round(value * 1e5) / 1e5;

/** A position as the heat line source writes it, to 7 decimals (1 cm) */
const lineDegrees = (value: number): number => Math.round(value * 1e7) / 1e7;

describe("DataManager", () => {
  let dataManager: DataManager;
  let mockApp: MockApp;

  const heatSource = (): MockSource => mockApp.map!.source(MAP_SOURCES.heat);
  const heatLayer = (): MockLayer => mockApp.map!.layer(MAP_LAYERS.heat);
  const isolatedSource = (): MockSource =>
    mockApp.map!.source(MAP_SOURCES.heatIsolated);
  /**
   * The GeoJSON a source holds: the text of the Blob URL a heat source is
   * given, which it holds until it is given the next one
   */
  const contentOf = <T extends GeoJSON.GeoJSON>(source: MockSource): T => {
    if (typeof source.data !== "string") return source.data as T;
    const text = blobUrls.get(source.data);
    if (text === undefined) throw new Error("a URL that was let go of");
    return JSON.parse(text) as T;
  };
  /** The `[lng, lat]` points a heat source holds, in full detail */
  const pointsOf = (source: MockSource): [number, number][] => {
    const data = contentOf<GeoJSON.FeatureCollection<GeoJSON.Point>>(source);
    expect(data.type).toBe("FeatureCollection");
    return data.features.map((feature) => {
      expect(feature.geometry.type).toBe("Point");
      return feature.geometry.coordinates as [number, number];
    });
  };
  const heatPoints = (): [number, number][] => pointsOf(heatSource());
  /**
   * The points of the heatmap that is drawn: the one of an isolated
   * selection while there is one, and only one of the two
   */
  const drawnHeatPoints = (): [number, number][] => {
    const opacity = (id: string): unknown =>
      mockApp.map!.layer(id).paint["heatmap-opacity"];
    const isolated = opacity(MAP_LAYERS.heatIsolated) !== 0;
    expect(opacity(MAP_LAYERS.heat) === 0).toBe(isolated);
    return pointsOf(isolated ? isolatedSource() : heatSource());
  };
  /**
   * The heatmap's points of baseData: the start of every segment, which
   * carries the time until the next fix, `[lng, lat]`
   */
  const HEAT_POINTS = [
    [8.0, 50.0],
    [8.1, 50.1],
    [10.0, 52.0],
  ];
  /** Every fix of baseData's segments, `[lng, lat]` */
  const ALL_FIXES = [
    [8.0, 50.0],
    [8.1, 50.1],
    [8.2, 50.2],
    [10.0, 52.0],
    [11.0, 53.0],
  ];
  /** The `[lng, lat]` points the heat line source draws, each once */
  const heatLinePoints = (): [number, number][] => {
    const data = contentOf<GeoJSON.FeatureCollection<GeoJSON.LineString>>(
      mockApp.map!.source(MAP_SOURCES.heatLines),
    );
    const points = new Map<string, [number, number]>();
    for (const feature of data.features) {
      for (const point of feature.geometry.coordinates) {
        points.set(point.join(), point as [number, number]);
      }
    }
    return [...points.values()];
  };
  /** How often a paint property of a heat layer was set */
  const paintCalls = (name: string, layer: string): unknown[][] =>
    mockApp.map!.setPaintProperty.mock.calls.filter(
      (call) => call[0] === layer && call[1] === name,
    );

  const baseData = (): KMLDataset =>
    createDataset(
      [
        // The exact altitude range of every path, as the exporter writes it
        {
          id: 1,
          year: 2025,
          aircraft_registration: "D-ABCD",
          min_altitude_ft: 1000,
          max_altitude_ft: 5000,
        },
        {
          id: 2,
          year: 2024,
          aircraft_registration: "D-EFGH",
          min_altitude_ft: 3000,
          max_altitude_ft: 3000,
        },
      ],
      [
        createSegment({ path_id: 1, altitude_ft: 1000 }),
        createSegment({
          path_id: 1,
          altitude_ft: 5000,
          coords: [
            [50.1, 8.1],
            [50.2, 8.2],
          ],
        }),
        createSegment({
          path_id: 2,
          altitude_ft: 3000,
          coords: [
            [52.0, 10.0],
            [53.0, 11.0],
          ],
        }),
      ],
      1000,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    const loadingEl = document.createElement("div");
    loadingEl.id = "loading";
    loadingEl.style.display = "none";
    document.body.appendChild(loadingEl);

    // The stylesheet's token; jsdom loads no stylesheet
    document.documentElement.style.setProperty(
      "--heatmap-dimmed-opacity",
      "0.35",
    );

    vi.stubGlobal("Blob", TextBlob);
    URL.createObjectURL = vi.fn((blob: Blob) => {
      const url = `blob:heat/${++blobUrlCount}`;
      blobUrls.set(url, (blob as TextBlob).json);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => void blobUrls.delete(url));
    loaderMocks.getDecoder.mockResolvedValue(decoder);

    mockApp = createMockApp();
    dataManager = new DataManager(asMapApp(mockApp));
  });

  afterEach(() => {
    document.getElementById("loading")?.remove();
    document.documentElement.style.removeProperty("--heatmap-dimmed-opacity");
    blobUrls.clear();
  });

  describe("constructor", () => {
    it("creates the DataLoader with the app data dir and callbacks", () => {
      expect(loaderMocks.options?.dataDir).toBe("data");
      expect(typeof loaderMocks.options?.showLoading).toBe("function");
      expect(typeof loaderMocks.options?.hideLoading).toBe("function");
      expect(typeof loaderMocks.options?.onLoadError).toBe("function");
    });

    it("wires show/hide loading callbacks to the loading element", () => {
      const loadingEl = document.getElementById("loading")!;
      loaderMocks.options!.showLoading!(loading({ years: ["2025"] }));
      expect(loadingEl.style.display).toBe("block");
      loaderMocks.options!.hideLoading!();
      expect(loadingEl.style.display).toBe("none");
    });

    it("shows an error toast listing failed years", () => {
      loaderMocks.options!.onLoadError!(["2024", "2025"]);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights of 2024, 2025",
        "error",
        undefined,
      );
    });
  });

  describe("showLoading/hideLoading", () => {
    let loadingEl: HTMLElement;
    let textEl: HTMLElement;
    let bar: HTMLElement;
    let frames: StubbedAnimationFrames;

    beforeEach(() => {
      loadingEl = document.getElementById("loading")!;
      textEl = document.createElement("span");
      textEl.id = "loading-text";
      textEl.textContent = "Loading data…";
      bar = document.createElement("div");
      bar.id = "loading-progress";
      bar.hidden = true;
      loadingEl.append(textEl, bar);
      frames = stubAnimationFrames();
    });

    /** Show a state and let the frame that draws it run */
    const draw = (state: LoadingState): void => {
      dataManager.showLoading(state);
      frames.run();
    };

    /** Every text the label is given from here on */
    const watchLabel = (): string[] => {
      const written: string[] = [];
      const descriptor = Object.getOwnPropertyDescriptor(
        Node.prototype,
        "textContent",
      )!;
      Object.defineProperty(textEl, "textContent", {
        configurable: true,
        get(this: Node) {
          return descriptor.get!.call(this) as string | null;
        },
        set(this: Node, value: string | null) {
          written.push(`${loadingEl.style.display}: ${value}`);
          descriptor.set!.call(this, value);
        },
      });
      return written;
    };

    const share = (): string =>
      bar.style.getPropertyValue("--loading-progress");

    it("toggles the loading element", () => {
      dataManager.showLoading(loading());
      expect(loadingEl.style.display).toBe("block");
      dataManager.hideLoading();
      expect(loadingEl.style.display).toBe("none");
    });

    it.each([
      [
        { years: ["2026"], fileBytes: 1.1 * 1024 * 1024 },
        "2026 flights (1.1 MB)",
      ],
      [{ all: true, fileBytes: 24 * 1024 * 1024 }, "all flights (24 MB)"],
      [{ years: ["2025"] }, "2025 flights"],
      [
        { years: ["2025", "2024"], fileBytes: 2048 },
        "2025, 2024 flights (2.0 KB)",
      ],
      [{ all: true, years: [] }, "all flights"],
    ])("describes what is loading: %j", (state, label) => {
      draw(loading(state));
      expect(textEl.textContent).toBe(`Loading ${label}…`);
    });

    it("comes up without a label and writes it a frame later, so the live region announces it", () => {
      draw(loading({ years: ["2025"] }));
      dataManager.hideLoading();
      const written = watchLabel();

      dataManager.showLoading(loading({ years: ["2024"] }));

      // No frame has run, and they are held back while the page is busy:
      // the label of the last load is gone all the same
      expect(frames.pending()).toBe(1);
      expect(written).toEqual(["block: "]);
      frames.run();
      expect(written).toEqual(["block: ", "block: Loading 2024 flights…"]);
    });

    it("leaves the label alone while only the numbers behind the bar change", () => {
      const state = { years: ["2025", "2024"], fileBytes: 4096 };
      draw(loading({ ...state, loadedBytes: 0, totalBytes: 4096 }));
      const written = watchLabel();

      draw(loading({ ...state, loadedBytes: 2048, totalBytes: 4096 }));
      // A new operation: the bar starts over, the files are the same
      draw(loading({ ...state, operation: 2, totalBytes: 1000 }));

      expect(written).toEqual([]);
    });

    it("writes the label again whenever what it says has changed", () => {
      const written = watchLabel();

      draw(loading({ years: ["2025"], fileBytes: 1024 }));
      draw(loading({ years: ["2025", "2024"], fileBytes: 3072 }));
      // "all" is asked for before its years are known
      draw(loading({ all: true, years: ["2025", "2024"], fileBytes: 3072 }));
      draw(loading({ all: true, years: ["2025", "2024", "2023"] }));
      // "all" gave up while a year is still loading, and 2025 failed
      draw(loading({ years: ["2024"], fileBytes: 2048 }));

      expect(written.slice(1)).toEqual([
        "block: Loading 2025 flights (1.0 KB)…",
        "block: Loading 2025, 2024 flights (3.0 KB)…",
        "block: Loading all flights (3.0 KB)…",
        "block: Loading all flights…",
        "block: Loading 2024 flights (2.0 KB)…",
      ]);
    });

    describe("download progress", () => {
      it("draws the bar once per frame, from the latest state", () => {
        const setProperty = vi.spyOn(bar.style, "setProperty");

        for (const loadedBytes of [100, 250, 370]) {
          dataManager.showLoading(loading({ loadedBytes, totalBytes: 1000 }));
        }

        expect(frames.pending()).toBe(1);
        expect(bar.hidden).toBe(true);
        frames.run();
        expect(setProperty).toHaveBeenCalledExactlyOnceWith(
          "--loading-progress",
          "0.37",
        );
        expect(bar.hidden).toBe(false);
      });

      it("looks the indicator up once per load, not once per chunk", () => {
        const lookup = vi.spyOn(domCache, "get");

        dataManager.showLoading(loading({ loadedBytes: 1, totalBytes: 1000 }));
        expect(lookup).toHaveBeenCalledWith("loading");
        lookup.mockClear();
        dataManager.showLoading(loading({ loadedBytes: 2, totalBytes: 1000 }));
        dataManager.showLoading(loading({ loadedBytes: 3, totalBytes: 1000 }));

        expect(lookup).not.toHaveBeenCalled();
      });

      it("moves the accessible value in steps of ten", () => {
        const setAttribute = vi.spyOn(bar, "setAttribute");

        // 300 of 1000 is the one that 0.3 * 10 would get wrong as a float
        for (const loadedBytes of [10, 99, 100, 199, 299, 300, 305, 1000]) {
          draw(loading({ loadedBytes, totalBytes: 1000 }));
        }

        expect(
          setAttribute.mock.calls
            .filter(([name]) => name === "aria-valuenow")
            .map(([, value]) => value),
        ).toEqual(["0", "10", "20", "30", "100"]);
      });

      it("displays the bar anew for a new operation, so its delay runs again", () => {
        draw(loading({ loadedBytes: 50, totalBytes: 100 }));
        const hidden = vi.spyOn(bar, "hidden", "set");

        draw(loading({ loadedBytes: 60, totalBytes: 100 }));
        expect(hidden.mock.calls).toEqual([[false]]);
        hidden.mockClear();

        // The same total as before: told apart by the operation alone
        draw(loading({ operation: 2, loadedBytes: 0, totalBytes: 100 }));
        expect(hidden.mock.calls).toEqual([[true], [false]]);
        expect(share()).toBe("0");
        hidden.mockClear();

        draw(loading({ operation: 2, loadedBytes: 10, totalBytes: 100 }));
        expect(hidden.mock.calls).toEqual([[false]]);
      });

      it("brings up no bar for a load whose bytes are all in", () => {
        draw(loading({ loadedBytes: 1000, totalBytes: 1000 }));
        draw(loading({ operation: 2, loadedBytes: 0, totalBytes: 0 }));

        expect(bar.hidden).toBe(true);
        expect(share()).toBe("");
      });

      it("keeps a bar that is up, full, when nothing is left to download", () => {
        draw(loading({ loadedBytes: 900, totalBytes: 1000 }));
        const hidden = vi.spyOn(bar, "hidden", "set");

        draw(loading({ loadedBytes: 1000, totalBytes: 1000 }));
        draw(loading({ operation: 2, loadedBytes: 0, totalBytes: 0 }));

        expect(hidden.mock.calls).toEqual([[false], [false]]);
        expect(share()).toBe("1");
        expect(bar.getAttribute("aria-valuenow")).toBe("100");
      });

      it("takes down a bar that another instance left behind", () => {
        bar.hidden = false;
        bar.setAttribute("aria-valuenow", "60");
        bar.style.setProperty("--loading-progress", "0.6");

        draw(loading());

        expect(bar.hidden).toBe(true);
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(share()).toBe("");
      });

      it("hides the bar without a total, and touches it only once", () => {
        draw(loading({ loadedBytes: 400, totalBytes: 1000 }));
        const removeAttribute = vi.spyOn(bar, "removeAttribute");

        draw(loading());
        draw(loading());

        expect(bar.hidden).toBe(true);
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(share()).toBe("");
        expect(removeAttribute).toHaveBeenCalledOnce();
      });

      it("hiding the indicator drops the bar and the frame it was waiting for", () => {
        draw(loading({ loadedBytes: 500, totalBytes: 1000 }));
        dataManager.showLoading(
          loading({ loadedBytes: 1000, totalBytes: 1000 }),
        );

        dataManager.hideLoading();

        expect(frames.pending()).toBe(0);
        expect(bar.hidden).toBe(true);
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(share()).toBe("");
      });

      it("takes the indicator down with the app, and draws nothing after", () => {
        draw(loading({ loadedBytes: 0, totalBytes: 1000 }));
        dataManager.showLoading(
          loading({ loadedBytes: 500, totalBytes: 1000 }),
        );

        dataManager.destroy();
        frames.run();
        dataManager.showLoading(
          loading({ loadedBytes: 700, totalBytes: 1000 }),
        );

        expect(frames.pending()).toBe(0);
        expect(loadingEl.style.display).toBe("none");
        expect(bar.hidden).toBe(true);
        expect(share()).toBe("");
      });

      it("ends the loader, and with it the year worker, with the app", () => {
        dataManager.destroy();

        expect(loaderMocks.destroy).toHaveBeenCalledTimes(1);
      });

      it("works without the bar in the template", () => {
        bar.remove();

        expect(() => {
          draw(loading({ loadedBytes: 1, totalBytes: 2 }));
          dataManager.hideLoading();
        }).not.toThrow();
      });
    });

    it("works without #loading-text", () => {
      textEl.remove();
      expect(() => draw(loading({ totalBytes: 10 }))).not.toThrow();
      expect(loadingEl.style.display).toBe("block");
    });

    it("handles a missing loading element", () => {
      loadingEl.remove();
      expect(() => draw(loading())).not.toThrow();
      expect(() => dataManager.hideLoading()).not.toThrow();
    });
  });

  describe("delegation", () => {
    it("loadData delegates to the loader", async () => {
      const data = baseData();
      loaderMocks.loadData.mockResolvedValue(data);
      expect(await dataManager.loadData("2025")).toBe(data);
      expect(loaderMocks.loadData).toHaveBeenCalledWith("2025", undefined);
    });

    it("loadAirports delegates to the loader", async () => {
      const airports = [{ name: "EDDF", lat: 50, lon: 8 }];
      loaderMocks.loadAirports.mockResolvedValue(airports);
      expect(await dataManager.loadAirports()).toBe(airports);
    });

    it("loadMetadata delegates to the loader", async () => {
      const metadata = { available_years: [2025] };
      loaderMocks.loadMetadata.mockResolvedValue(metadata);
      expect(await dataManager.loadMetadata()).toBe(metadata);
    });
  });

  describe("loadData", () => {
    const signalOf = (call: number): AbortSignal =>
      loaderMocks.loadData.mock.calls[call]![1] as AbortSignal;

    it("keeps a load under way when another year joins (regression)", async () => {
      // The first load's caller is still waiting: the indicator carries
      // both years instead of dropping the first
      loaderMocks.loadData.mockResolvedValue(null);
      const first = dataManager.loadData("2024");
      const second = dataManager.loadData("2025");

      expect(signalOf(0)).toBeUndefined();
      expect(signalOf(1)).toBeUndefined();
      await Promise.all([first, second]);
    });

    it("hands the caller's signal to the loader, and toasts no aborted load", async () => {
      loaderMocks.loadData.mockResolvedValue(null);
      const controller = new AbortController();
      const load = dataManager.loadData("2024", controller.signal);
      controller.abort();
      await load;

      expect(signalOf(0)).toBe(controller.signal);
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("toasts a dataset that is not there", async () => {
      loaderMocks.loadData.mockResolvedValue(null);

      await dataManager.loadData("2025");

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights of 2025",
        "error",
        undefined,
      );
    });

    it("names no year in the toast for 'all'", async () => {
      loaderMocks.loadData.mockResolvedValue(null);

      await dataManager.loadData("all");

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights",
        "error",
        undefined,
      );
    });

    it("does not double-toast when the loader already reported the failure", async () => {
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });

      await dataManager.loadData("2025");

      expect(toastMock.showToast).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights of 2025",
        "error",
        undefined,
      );
    });

    it("says a failure on the note of an empty map, and in a toast over flights", async () => {
      const note = vi.fn();
      dataManager.failureNote = note;
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });
      mockApp.currentData = null;

      await dataManager.loadData("2025");

      // Once, where its Retry is: the toast beside it said it twice
      expect(note).toHaveBeenCalledExactlyOnceWith(
        "Could not load the flights of 2025",
      );
      expect(toastMock.showToast).not.toHaveBeenCalled();

      // Over the flights of another year the toast says it, as before
      mockApp.currentData = createDataset([{ id: 1, year: 2024 }]);
      await dataManager.loadData("2025");

      expect(note).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights of 2025",
        "error",
        undefined,
      );
    });

    it("puts what failed on the note into a toast when some years load", async () => {
      const note = vi.fn();
      dataManager.failureNote = note;
      mockApp.currentData = null;
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2023"]);
        const partial = createDataset([{ id: 1, year: 2024 }]);
        partial.incomplete = true;
        return Promise.resolve(partial);
      });

      await dataManager.loadData("all");

      // The flights of the other years hide the note it went on
      expect(note).toHaveBeenCalledOnce();
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "Could not load the flights of 2023",
        "error",
        undefined,
      );
    });

    it("offers the caller's retry on the toast of a failed load", async () => {
      const retry = { label: "Retry", run: vi.fn() };
      loaderMocks.loadData.mockImplementation(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });

      await dataManager.loadData("2025", undefined, retry);
      expect(toastMock.showToast).toHaveBeenLastCalledWith(
        "Could not load the flights of 2025",
        "error",
        retry,
      );

      loaderMocks.loadData.mockResolvedValue(null);
      await dataManager.loadData("2024", undefined, retry);
      expect(toastMock.showToast).toHaveBeenLastCalledWith(
        "Could not load the flights of 2024",
        "error",
        retry,
      );
    });

    it("keeps a switch's Retry off the years of a load of all it replaced", async () => {
      // The load of all years goes on after a switch replaced it, and its
      // failure used to carry the Retry of the switch, for another year
      const retry = { label: "Retry", run: vi.fn() };
      let finishAll: () => void = () => {};
      loaderMocks.loadData.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAll = () => {
              loaderMocks.options!.onLoadError!(["2023"]);
              resolve(null);
            };
          }),
      );
      const all = dataManager.loadData("all", undefined, retry);
      loaderMocks.loadData.mockReturnValueOnce(new Promise(() => {}));
      void dataManager.loadData("2025", undefined, retry);

      finishAll();
      await all;

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights of 2023",
        "error",
        undefined,
      );
    });

    it("takes the failures on screen away once a dataset has loaded", async () => {
      loaderMocks.loadData.mockImplementationOnce(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });
      await dataManager.loadData("2025");
      loaderMocks.loadData.mockResolvedValueOnce({
        ...baseData(),
        incomplete: true,
      });
      await dataManager.loadData("all");
      // Some years of all are missing: that failure is still true
      expect(toastMock.dismissToast).not.toHaveBeenCalled();

      // An error stays until dismissed; once the page has a whole dataset
      // again, it no longer says anything about what is on screen
      loaderMocks.loadData.mockResolvedValueOnce(baseData());
      await dataManager.loadData("2025");

      expect(toastMock.dismissToast).toHaveBeenCalledWith(
        "Could not load the flights of 2025",
      );
    });

    it("takes only the failures of loads away when told to", async () => {
      loaderMocks.loadData.mockImplementationOnce(() => {
        loaderMocks.options!.onLoadError!(["2025"]);
        return Promise.resolve(null);
      });
      await dataManager.loadData("2025");

      dataManager.dismissFailures();

      // By message: a Retry took every error on screen with it, another
      // one that is still true included (regression)
      expect(toastMock.dismissToast).toHaveBeenCalledTimes(1);
      expect(toastMock.dismissToast).toHaveBeenCalledWith(
        "Could not load the flights of 2025",
      );
      toastMock.dismissToast.mockClear();
      dataManager.dismissFailures();
      expect(toastMock.dismissToast).not.toHaveBeenCalled();
    });

    it("asks for a reload when the site changed since the page loaded", () => {
      loaderMocks.options!.onLoadError!(["2024", "2025"], true);

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Could not load the flights of 2024, 2025. Reload the page to update it.",
        "error",
        undefined,
      );
    });
  });

  describe("drawing what the store holds", () => {
    const publish = (data: KMLDataset): void => {
      mockApp.currentData = data;
    };

    it("draws nothing without a map or before the first dataset", () => {
      mockApp.selectedYear = "2025";
      dataManager.updateLayers();
      expect(heatSource().setData).not.toHaveBeenCalled();

      mockApp.map = null;
      publish(baseData());
      expect(mockApp.layerManager.syncModes).not.toHaveBeenCalled();
    });

    it("hands the heat source every coordinate, longitude first, when unfiltered", async () => {
      const data = baseData();

      publish(data);
      await answered();

      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(heatPoints()).toEqual(HEAT_POINTS);
      expect(data.path_segments).toHaveLength(HEAT_POINTS.length);
    });

    it("loads nothing: the dataset is published by whoever loaded it", () => {
      publish(baseData());
      mockApp.selectedAircraft = "D-EFGH";

      expect(loaderMocks.loadData).not.toHaveBeenCalled();
    });

    it("gives the heat layer its paint on first use", () => {
      expect(heatLayer().paint).toEqual({});

      publish(baseData());

      expect(heatLayer().paint).toEqual(heatmapPaint());
      expect(heatLayer().paint["heatmap-radius"]).toEqual([
        "interpolate",
        ["linear"],
        ["zoom"],
        ...HEATMAP_RADIUS_PX.flat(),
      ]);
      for (const [id, paint] of Object.entries(heatLinesPaint())) {
        expect(mockApp.map!.layer(id).paint).toEqual(paint);
      }
    });

    it("sets the paint once, not with every new set of points", async () => {
      mockApp.heatmapVisible = false;
      publish(baseData());
      await answered();
      publish(baseData());
      await answered();
      dataManager.showHeatmap();

      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      for (const name of [
        "heatmap-radius",
        "heatmap-weight",
        "heatmap-intensity",
        "heatmap-color",
      ]) {
        expect(paintCalls(name, MAP_LAYERS.heat)).toHaveLength(1);
      }
    });

    it("feeds the one heat source new points and adds nothing to the map", async () => {
      const sources = mockApp.map!.addSource.mock.calls.length;
      const layers = mockApp.map!.addLayer.mock.calls.length;

      publish(baseData());
      await answered();
      mockApp.selectedAircraft = "D-EFGH";
      await answered();

      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.addSource).toHaveBeenCalledTimes(sources);
      expect(mockApp.map!.addLayer).toHaveBeenCalledTimes(layers);
    });

    it("leaves the visibility of the heatmap to the store", () => {
      mockApp.heatmapVisible = true;

      publish(baseData());

      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });

    it("calculates altitude range from the paths of the segments", () => {
      publish(baseData());

      expect(mockApp.altitudeRange).toMatchObject({ min: 1000, max: 5000 });
    });

    it("takes the exact altitude of a path over its rounded segments", () => {
      const data = baseData();
      data.path_info[0]!.max_altitude_ft = 4960.4;
      data.path_info[0]!.min_altitude_ft = 1012.5;

      publish(data);

      expect(mockApp.altitudeRange).toMatchObject({
        min: 1012.5,
        max: 4960.4,
      });
    });

    it("keeps the previous altitude range when there are no segments", () => {
      mockApp.altitudeRange = { min: 5, max: 6 };

      publish(createDataset());

      expect(mockApp.altitudeRange).toEqual({ min: 5, max: 6 });
    });

    it("filters heatmap coordinates by selected year", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);
      mockApp.selectedYear = "2025";

      publish(baseData());
      await answered();

      expect(heatPoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
      ]);
      // The heat lines draw the same flights, to their ends
      expect(heatLinePoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
    });

    it("hands the heat lines every flight when unfiltered", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);

      publish(baseData());
      await answered();

      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });

    it("asks the year worker for the heat lines of the paths a heat keeps", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);
      const data = baseData();
      publish(data);
      await answered();
      const exposure = mockApp.heatmapExposure;

      expect(decoder.heatLines).toHaveBeenLastCalledWith(
        data.path_segments,
        null,
        exposure,
      );
      mockApp.store.batch(() => {
        mockApp.selectedPathIds = new Set([2, 3]);
        mockApp.selectedAircraft = "D-EFGH";
        mockApp.isolateSelection = true;
      });
      await answered();

      // Of the whole dataset, which the worker holds already, the selected
      // flights the filter shows
      const [segments, keep] = decoder.heatLines.mock.lastCall!;
      expect(segments).toBe(data.path_segments);
      expect([...keep!]).toEqual([2]);
    });

    it("filters heatmap coordinates by selected aircraft", async () => {
      publish(baseData());

      mockApp.selectedAircraft = "D-EFGH";
      await answered();

      expect(heatPoints()).toEqual([[10.0, 52.0]]);
    });

    it("filters heatmap coordinates by selection in share mode", async () => {
      publish(baseData());
      await answered();

      mockApp.store.batch(() => {
        mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
        mockApp.isolateSelection = true;
      });
      await answered();

      expect(drawnHeatPoints()).toEqual([[10.0, 52.0]]);
      // The heat source keeps the dataset's points, and is not written again
      expect(heatPoints()).toEqual(HEAT_POINTS);
      expect(heatSource().setData).toHaveBeenCalledOnce();
    });

    it("isolates only the selected paths the aircraft filter keeps (regression)", async () => {
      // Path 1 is D-ABCD, path 2 is D-EFGH: the colour layers draw only
      // path 2, so the heatmap must not draw path 1 beside it
      mockApp.selectedAircraft = "D-EFGH";
      mockApp.isolateSelection = true;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);

      publish(baseData());
      await answered();

      expect(drawnHeatPoints()).toEqual([[10.0, 52.0]]);
    });

    it("only restyles the paths for a selection outside share mode", async () => {
      publish(baseData());
      await answered();
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      await answered();

      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        1,
      );
      expect(mockApp.layerManager.syncModes).not.toHaveBeenCalled();
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
    });

    it("gives the heatmap its points for a selection in share mode, and restyles the paths", async () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      publish(baseData());
      await answered();
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      // The colour layers keep their runs: isolation is a filter on them
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      await answered();

      expect(drawnHeatPoints()).toEqual(HEAT_POINTS);
      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        1,
      );

      // Leaving it, and coming back
      mockApp.selectedPathIds = new Set(
        [...mockApp.selectedPathIds].filter((id) => id !== 1),
      );
      await answered();
      mockApp.isolateSelection = false;
      // Back to the dataset's own points
      expect(drawnHeatPoints()).toEqual(HEAT_POINTS);
      mockApp.isolateSelection = true;
      expect(drawnHeatPoints()).toEqual([[10.0, 52.0]]);

      expect(mockApp.layerManager.updateSelectionStyles).toHaveBeenCalledTimes(
        4,
      );
      expect(mockApp.layerManager.syncModes).not.toHaveBeenCalled();
    });

    it("draws a filter change that lands in one update once", () => {
      publish(baseData());
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      mockApp.store.batch(() => {
        mockApp.selectedYear = "2025";
        mockApp.currentData = baseData();
        mockApp.selectedAircraft = "D-ABCD";
        mockApp.selectedPathIds = new Set();
      });

      expect(mockApp.layerManager.syncModes).toHaveBeenCalledTimes(1);
    });

    it("does not send the heat source the points it already holds", async () => {
      // The map's worker would read and cut them anew
      publish(baseData());
      await answered();
      const held = heatPoints();

      // The whole dataset again, and a selection that isolates nothing
      dataManager.updateLayers();
      mockApp.selectedPathIds = new Set([1]);
      dataManager.updateLayers();
      await answered();
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(decoder.drawHeat).toHaveBeenCalledOnce();

      // Filtered points are a new array each time, of the same coordinates
      mockApp.selectedYear = "2025";
      dataManager.updateLayers();
      await answered();
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).not.toEqual(held);
    });

    it("isolates to a source of its own, and sends the heat source's points again only once they change", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);
      const data = baseData();
      publish(data);
      await answered();

      // Isolate costs the points of the selection, not of every flight
      mockApp.store.batch(() => {
        mockApp.selectedPathIds = new Set([2]);
        mockApp.isolateSelection = true;
      });
      await answered();
      expect(heatSource().setData).toHaveBeenCalledOnce();
      expect(isolatedSource().setData).toHaveBeenCalledOnce();
      expect(drawnHeatPoints()).toEqual([[10.0, 52.0]]);
      expect(heatLinePoints()).toEqual([
        [10.0, 52.0],
        [11.0, 53.0],
      ]);
      // The heat legend follows the exposure of the heat drawn
      const exposureOf = (keep: (pathId: number) => boolean): number => {
        const { points, weights } = heatmapPoints(
          data.path_segments,
          keep,
          heatWeight,
        );
        return heatExposure(heatColumns(points, weights));
      };
      expect(mockApp.heatmapExposure).toBe(exposureOf((id) => id === 2));

      // And leaving it nothing but a switch of the two, which the year
      // worker has drawn already
      mockApp.isolateSelection = false;
      expect(mockApp.heatmapExposure).toBe(exposureOf(() => true));
      await answered();
      expect(heatSource().setData).toHaveBeenCalledOnce();
      expect(isolatedSource().setData).toHaveBeenCalledOnce();
      expect(decoder.drawHeat).toHaveBeenCalledTimes(2);
      expect(drawnHeatPoints()).toEqual(HEAT_POINTS);
      expect(heatLinePoints()).toEqual(ALL_FIXES);
      // Isolated again, the same selection's points are still there
      mockApp.isolateSelection = true;
      expect(isolatedSource().setData).toHaveBeenCalledOnce();
      expect(drawnHeatPoints()).toEqual([[10.0, 52.0]]);
      mockApp.isolateSelection = false;

      // The same points of another dataset are other points
      publish(baseData());
      await answered();
      expect(heatSource().setData).toHaveBeenCalledTimes(2);
    });

    it("brings the colour layers along, as a rebuild", () => {
      publish(baseData());

      expect(mockApp.layerManager.syncModes).toHaveBeenCalledWith(true);
    });

    it("publishes nothing itself and calls no manager for the dataset", () => {
      const listener = vi.fn();
      mockApp.store.subscribe("currentData", listener);

      publish(baseData());

      expect(listener).toHaveBeenCalledTimes(1);
      // Statistics and airport markers follow the store on their own
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(mockApp.airportManager.showAirports).not.toHaveBeenCalled();
    });
  });

  describe("the year worker's part", () => {
    /** An answer of the year worker that arrives when the test says */
    function held<T>(): {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (error: unknown) => void;
    } {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    }

    it("hands the heat source a Blob URL of the GeoJSON the worker wrote", async () => {
      const data = baseData();

      mockApp.currentData = data;
      await answered();

      const [points, weights] = decoder.drawHeat.mock.calls[0]!;
      expect(points).toEqual(
        heatmapPoints(data.path_segments, () => true, heatWeight).points,
      );
      const url = heatSource().setData.mock.calls[0]![0] as string;
      expect(url).toMatch(/^blob:/);
      // The text JSON.stringify writes for a Point per fix, heat and all,
      // to 5 decimals and 4 significant digits (services/heatSource.ts)
      const drawn = exposedHeat(heatColumns(points, weights));
      expect(blobUrls.get(url)).toBe(
        JSON.stringify({
          type: "FeatureCollection",
          features: points.map(([lat, lng], i) => ({
            type: "Feature",
            properties: { w: +drawn.weights[i]!.toPrecision(4) },
            geometry: { type: "Point", coordinates: [lng, lat].map(degrees) },
          })),
        }),
      );
      expect(mockApp.heatmapExposure).toBe(drawn.exposure);
    });

    it("lets go of the URL a source held once it has taken the next, and of the last ones with the app", async () => {
      mockApp.currentData = baseData();
      await answered();
      const first = heatSource().data as string;
      const taken = held<void>();
      heatSource().setData.mockImplementationOnce((data: unknown) => {
        heatSource().data = data;
        return taken.promise;
      });

      mockApp.selectedYear = "2025";
      await answered();

      // The source may still be reading it
      const second = heatSource().data as string;
      expect(second).not.toBe(first);
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      taken.resolve();
      await answered();
      expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(first);

      dataManager.destroy();
      expect(URL.revokeObjectURL).toHaveBeenLastCalledWith(second);
    });

    it("keeps the heat and the legend of before until the worker has drawn the new heat", async () => {
      mockApp.currentData = baseData();
      await answered();
      // What the legend says of the heat drawn so far
      const exposure = 42;
      mockApp.heatmapExposure = exposure;
      const answer = held<ReturnType<typeof drawHeat>>();
      decoder.drawHeat.mockReturnValueOnce(answer.promise);

      mockApp.selectedAircraft = "D-EFGH";
      await answered();

      expect(heatSource().setData).toHaveBeenCalledOnce();
      expect(mockApp.heatmapExposure).toBe(exposure);
      expect(heatPoints()).toEqual(HEAT_POINTS);
      const [points, weights] = decoder.drawHeat.mock.calls[1]!;
      const drawn = drawHeat(heatColumns(points, weights));
      answer.resolve(drawn);
      await answered();
      expect(heatPoints()).toEqual([[10.0, 52.0]]);
      expect(mockApp.heatmapExposure).toBe(drawn.exposure);
    });

    it("counts the requests the worker has not answered, for a map that is idle meanwhile", async () => {
      mockApp.heatmapLayer.setVisible(true);
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      const answer = held<ReturnType<typeof drawHeat>>();
      decoder.drawHeat.mockReturnValueOnce(answer.promise);

      mockApp.currentData = baseData();
      await answered();
      expect(dataManager.heatRequests).toBe(1);

      const [points, weights] = decoder.drawHeat.mock.calls[0]!;
      answer.resolve(drawHeat(heatColumns(points, weights)));
      // The heat, then its lines
      await answered();
      expect(dataManager.heatRequests).toBe(0);
      expect(heatSource().setData).toHaveBeenCalledOnce();
      expect(heatLinePoints()).toEqual(ALL_FIXES);

      decoder.drawHeat.mockRejectedValueOnce(new Error("no answer"));
      mockApp.selectedYear = "2025";
      expect(dataManager.heatRequests).toBe(1);
      await answered();
      expect(dataManager.heatRequests).toBe(0);
    });

    it("writes no heat that was let go of before the worker answered", async () => {
      const answer = held<ReturnType<typeof drawHeat>>();
      decoder.drawHeat.mockReturnValueOnce(answer.promise);
      mockApp.currentData = baseData();

      mockApp.selectedAircraft = "D-EFGH";
      await answered();
      answer.resolve(drawHeat(heatColumns([[50, 8]], [1])));
      await answered();

      expect(heatSource().setData).toHaveBeenCalledOnce();
      expect(heatPoints()).toEqual([[10.0, 52.0]]);
    });

    it("draws an isolated selection once the worker has drawn its heat, and the heat of before until then", async () => {
      mockApp.currentData = baseData();
      await answered();
      const answer = held<ReturnType<typeof drawHeat>>();
      decoder.drawHeat.mockReturnValueOnce(answer.promise);

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.isolateSelection = true;
      await answered();

      // Its source holds nothing yet, or the selection isolated before
      expect(drawnHeatPoints()).toEqual(HEAT_POINTS);
      const [points, weights] = decoder.drawHeat.mock.calls[1]!;
      answer.resolve(drawHeat(heatColumns(points, weights)));
      await answered();
      expect(drawnHeatPoints()).toEqual([[10.0, 52.0]]);
    });

    it("has the map drawn again once the worker has answered every request", async () => {
      const answer = held<ReturnType<typeof drawHeat>>();
      decoder.drawHeat.mockReturnValueOnce(answer.promise);
      mockApp.currentData = baseData();
      mockApp.selectedAircraft = "D-EFGH";
      await answered();
      mockApp.map!.triggerRepaint.mockClear();

      // The heat let go of is not written, which leaves the map at rest
      answer.resolve(drawHeat(heatColumns([[50, 8]], [1])));
      await answered();

      expect(dataManager.heatRequests).toBe(0);
      expect(mockApp.map!.triggerRepaint).toHaveBeenCalledOnce();
    });

    it("writes only the heat lines asked for last", async () => {
      mockApp.heatmapLayer.setVisible(true);
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      const first = held<Blob>();
      decoder.heatLines.mockReturnValueOnce(first.promise);
      mockApp.currentData = baseData();
      await answered();

      mockApp.selectedYear = "2025";
      await answered();
      first.resolve(new Blob(['{"type":"FeatureCollection","features":[]}']));
      await answered();

      const lines = mockApp.map!.source(MAP_SOURCES.heatLines);
      expect(lines.setData).toHaveBeenCalledOnce();
      expect(heatLinePoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
    });

    it("logs a heat the worker failed over, and asks for it again", async () => {
      decoder.drawHeat.mockRejectedValueOnce(new Error("no answer"));
      mockApp.currentData = baseData();
      await answered();

      expect(logError).toHaveBeenCalledWith(
        "Could not draw the heat:",
        expect.any(Error),
      );
      expect(heatSource().setData).not.toHaveBeenCalled();

      dataManager.updateLayers();
      await answered();
      expect(decoder.drawHeat).toHaveBeenCalledTimes(2);
      expect(heatPoints()).toEqual(HEAT_POINTS);
    });

    it("says nothing of the requests the worker takes along as it ends with the app", async () => {
      const answer = held<ReturnType<typeof drawHeat>>();
      decoder.drawHeat.mockReturnValueOnce(answer.promise);
      mockApp.currentData = baseData();

      dataManager.destroy();
      answer.reject(new Error("year decoder destroyed"));
      await answered();

      expect(logError).not.toHaveBeenCalled();
      expect(heatSource().setData).not.toHaveBeenCalled();
    });
  });

  describe("heat lines", () => {
    const heatLinesSource = (): MockSource =>
      mockApp.map!.source(MAP_SOURCES.heatLines);

    // Shown, the way the app shows it for heatmapVisible
    beforeEach(() => mockApp.heatmapLayer.setVisible(true));

    it("are not worked out while the heatmap is zoomed out", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 1.5 });

      mockApp.currentData = baseData();
      await answered();

      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(heatLinesSource().setData).not.toHaveBeenCalled();
    });

    it("are worked out once a zoom ends near the hand-over, once per set of points", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 1.5 });
      mockApp.currentData = baseData();
      await answered();

      // Not in a frame of the zoom, which they would hold up
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 0.5 });
      mockApp.map!.emit("zoom");
      await answered();
      expect(heatLinesSource().setData).not.toHaveBeenCalled();
      // A level short of it, so a zoom on in finds them ready
      mockApp.map!.emit("zoomend");
      await answered();
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(1);
      expect(heatLinePoints()).toEqual(ALL_FIXES);

      // Zooming on, and a redraw with the same points, work out nothing
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.map!.emit("zoomend");
      dataManager.updateLayers();
      await answered();
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(1);
      expect(decoder.heatLines).toHaveBeenCalledOnce();
    });

    it("are asked for again at the next zoom when the worker failed over them", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      decoder.heatLines.mockRejectedValueOnce(new Error("no answer"));
      mockApp.currentData = baseData();
      await answered();
      expect(logError).toHaveBeenCalledWith(
        "Could not draw the heat:",
        expect.any(Error),
      );
      expect(heatLinesSource().setData).not.toHaveBeenCalled();

      mockApp.map!.emit("zoomend");
      await answered();

      expect(decoder.heatLines).toHaveBeenCalledTimes(2);
      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });

    it("are not asked for again after a failure over lines asked for before them", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      let fail!: (error: unknown) => void;
      decoder.heatLines.mockReturnValueOnce(
        new Promise<Blob>((_, no) => (fail = no)),
      );
      mockApp.currentData = baseData();
      await answered();
      mockApp.selectedYear = "2025";
      await answered();
      expect(decoder.heatLines).toHaveBeenCalledTimes(2);

      fail(new Error("no answer"));
      await answered();
      mockApp.map!.emit("zoomend");
      await answered();

      // The lines of the year shown were written, and stay
      expect(decoder.heatLines).toHaveBeenCalledTimes(2);
      expect(heatLinesSource().setData).toHaveBeenCalledOnce();
    });

    it("are not asked for again after a failure over a heat", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.currentData = baseData();
      await answered();
      expect(decoder.heatLines).toHaveBeenCalledOnce();

      // The heat of a selection isolated
      decoder.drawHeat.mockRejectedValueOnce(new Error("no answer"));
      mockApp.selectedPathIds = new Set([1]);
      mockApp.isolateSelection = true;
      dataManager.updateLayers();
      await answered();
      expect(logError).toHaveBeenCalled();
      mockApp.isolateSelection = false;
      dataManager.updateLayers();
      mockApp.map!.emit("zoomend");
      await answered();

      expect(decoder.heatLines).toHaveBeenCalledOnce();
    });

    it("are not worked out for a hidden heatmap, and are once it shows", async () => {
      mockApp.heatmapLayer.setVisible(false);
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });

      mockApp.currentData = baseData();
      mockApp.map!.emit("zoomend");
      await answered();
      expect(heatLinesSource().setData).not.toHaveBeenCalled();

      mockApp.heatmapVisible = true;
      dataManager.showHeatmap();
      await answered();
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(1);
      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });

    it("of other points are taken off while they are not worked out, so a zoom in from further out shows none of them (regression)", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.currentData = baseData();
      await answered();
      expect(heatLinePoints()).toEqual(ALL_FIXES);
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom - 1.5 });
      mockApp.map!.emit("zoomend");

      // Other points, with the map zoomed out: the lines of the old ones
      // would show from HEAT_LINES.fromZoom on until a zoom in ends
      mockApp.selectedYear = "2025";
      expect(heatLinePoints()).toEqual([]);
      // And once off, they are not taken off again
      mockApp.selectedYear = "all";
      await answered();
      expect(heatLinesSource().setData).toHaveBeenCalledTimes(2);

      mockApp.selectedYear = "2025";
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.map!.emit("zoomend");
      await answered();
      expect(heatLinePoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
    });

    it("of other points are taken off for a hidden heatmap as well", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.currentData = baseData();
      await answered();
      mockApp.heatmapLayer.setVisible(false);

      mockApp.selectedYear = "2025";

      expect(heatLinePoints()).toEqual([]);
    });

    it("stops following the map with the app", async () => {
      mockApp.currentData = baseData();
      dataManager.destroy();

      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.map!.emit("zoomend");
      mockApp.map!.emit("webglcontextrestored");
      mockApp.map!.emit("style.load");
      // Nor does the answer of the year worker it asked before
      await answered();
      expect(heatSource().setData).not.toHaveBeenCalled();

      expect(heatLinesSource().setData).not.toHaveBeenCalled();
      expect(mockApp.map!.listenerCount("zoomend")).toBe(0);
    });
  });

  describe("the heat's exposure", () => {
    const publish = (data: KMLDataset): void => {
      mockApp.currentData = data;
    };
    /** The heat of each point the heat source holds */
    const heatOfPoints = (): number[] =>
      contentOf<GeoJSON.FeatureCollection<GeoJSON.Point, { w: number }>>(
        heatSource(),
      ).features.map((feature) => feature.properties.w);
    /** A flight that taxies out and takes off, with times */
    const departure = (): KMLDataset =>
      createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({ time: 0, groundspeed_knots: 12 }),
          createSegment({
            time: 60,
            groundspeed_knots: 80,
            coords: [
              [50.1, 8.1],
              [50.2, 8.2],
            ],
          }),
          createSegment({
            time: 90,
            groundspeed_knots: 90,
            coords: [
              [50.2, 8.2],
              [50.3, 8.3],
            ],
          }),
        ],
      );

    it("scales the heat of the points by its exposure, and the lines' alike", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fromZoom });
      mockApp.heatmapLayer.setVisible(true);
      const data = departure();

      publish(data);
      await answered();

      const { points, weights } = heatmapPoints(
        data.path_segments,
        () => true,
        heatWeight,
      );
      const exposure = heatExposure(heatColumns(points, weights));
      expect(exposure).not.toBe(1);
      // Scaled, and rolled off where the heat is past the knee
      const drawn = exposedHeat(heatColumns(points, weights));
      expect(drawn.exposure).toBe(exposure);
      expect(heatOfPoints()).toEqual(
        [...drawn.weights].map((weight) => +weight.toPrecision(4)),
      );
      drawn.weights.forEach((weight, i) =>
        expect(weight).toBeLessThanOrEqual(weights[i]! * exposure),
      );
      // The heat legend reads it (ui/heatScale.ts)
      expect(mockApp.heatmapExposure).toBe(exposure);
      // The paint stays as it is: the heat is what is scaled
      expect(heatLayer().paint).toEqual(heatmapPaint());
      const lines = contentOf<
        GeoJSON.FeatureCollection<GeoJSON.LineString, { heat: number }>
      >(mockApp.map!.source(MAP_SOURCES.heatLines));
      const unscaled = heatLineFeatures(data.path_segments, () => true);
      expect(lines.features.map((line) => line.properties.heat)).not.toEqual(
        unscaled.features.map((line) => line.properties.heat),
      );
      // Rolled off as the heatmap's heat, at the positions as written
      const expected = heatLineFeatures(
        data.path_segments,
        () => true,
        (segment, next) => heatWeight(segment, next) * exposure,
        heatLineTone,
      );
      for (const line of expected.features) {
        line.geometry.coordinates = line.geometry.coordinates.map((position) =>
          position.map(lineDegrees),
        );
      }
      expect(lines).toEqual(expected);
    });
  });

  it("hands out the years the loader holds, without loading any", () => {
    const data = createDataset([], []);
    loaderMocks.cachedData.mockImplementation((year: string) =>
      year === "2024" ? data : undefined,
    );

    expect(dataManager.cachedData("2024")).toBe(data);
    expect(dataManager.cachedData("2023")).toBeUndefined();
    expect(loaderMocks.loadData).not.toHaveBeenCalled();
  });

  describe("a lost WebGL context", () => {
    /**
     * The map as MapLibre leaves it between the loss and the restored
     * style: no style, so no source to write to
     */
    function loseContext(): () => void {
      const getSource = mockApp.map!.getSource.getMockImplementation()!;
      mockApp.map!.getSource.mockImplementation(() => undefined);
      return () => {
        mockApp.map!.getSource.mockImplementation(getSource);
        mockApp.map!.emit("webglcontextrestored");
        mockApp.map!.emit("style.load");
      };
    }

    it("writes the points of a redraw during the loss once the style is back", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.heatmapLayer.setVisible(true);
      mockApp.currentData = baseData();
      await answered();
      const restore = loseContext();

      mockApp.selectedYear = "2025";
      await answered();
      expect(heatSource().setData).toHaveBeenCalledTimes(1);

      restore();
      await answered();

      expect(heatSource().setData).toHaveBeenCalledTimes(2);
      expect(heatPoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
      ]);
      expect(heatLinePoints()).toEqual([
        [8.0, 50.0],
        [8.1, 50.1],
        [8.2, 50.2],
      ]);
    });

    it("leaves the heat and its lines the restored sources hold as they are, the last written", async () => {
      mockApp.map!.jumpTo({ zoom: HEAT_LINES.fullZoom });
      mockApp.heatmapLayer.setVisible(true);
      mockApp.currentData = baseData();
      await answered();
      const restore = loseContext();

      restore();
      await answered();

      // MapLibre builds the style anew from the one at the loss, which
      // holds the data last handed to each source
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
      expect(
        mockApp.map!.source(MAP_SOURCES.heatLines).setData,
      ).toHaveBeenCalledTimes(1);
      expect(heatLinePoints()).toEqual(ALL_FIXES);
    });
  });

  describe("hidden heat layer", () => {
    it("takes new points while it is hidden and redraws the colour layers", async () => {
      mockApp.heatmapVisible = false;
      const data = baseData();

      mockApp.currentData = data;
      await answered();

      expect(heatPoints()).toHaveLength(data.path_segments.length);
      expect(heatLayer().layout["visibility"]).toBe("none");
      expect(mockApp.layerManager.syncModes).toHaveBeenCalledTimes(1);
    });

    it("shows the layer through its handle without feeding it again", async () => {
      mockApp.heatmapVisible = false;
      mockApp.currentData = baseData();
      await answered();

      mockApp.heatmapVisible = true;
      dataManager.showHeatmap();
      await answered();

      expect(mockApp.heatmapLayer.setVisible).toHaveBeenCalledWith(true);
      expect(mockApp.heatmapLayer.isVisible()).toBe(true);
      expect(heatLayer().layout["visibility"]).toBe("visible");
      expect(heatSource().setData).toHaveBeenCalledTimes(1);
    });

    it("paints a layer that is shown before it got any points", () => {
      dataManager.showHeatmap();

      expect(heatLayer().paint).toEqual(heatmapPaint());
    });

    it("does nothing without a map", () => {
      mockApp.map = null;

      expect(() => dataManager.showHeatmap()).not.toThrow();
      expect(mockApp.heatmapLayer.setVisible).not.toHaveBeenCalled();
    });

    it("leaves a map alone whose style has no heat source yet", () => {
      mockApp.map!.removeLayer(MAP_LAYERS.heat);
      mockApp.map!.removeSource(MAP_SOURCES.heat);

      expect(() => {
        mockApp.currentData = baseData();
      }).not.toThrow();

      expect(mockApp.map!.setPaintProperty).not.toHaveBeenCalled();
      expect(mockApp.layerManager.syncModes).toHaveBeenCalledTimes(1);
    });
  });

  describe("heatmapPoints", () => {
    const start: [number, number] = [50, 8];
    const mid: [number, number] = [50.1, 8.1];
    const end: [number, number] = [50.2, 8.2];
    const other: [number, number] = [52, 10];
    const otherEnd: [number, number] = [53, 11];
    const segments = [
      createSegment({ path_id: 1, coords: [start, mid], time: 0 }),
      createSegment({ path_id: 1, coords: [mid, end], time: 8 }),
      createSegment({ path_id: 2, coords: [other, otherEnd] }),
    ];
    const byTime = heatWeight;

    it("lists every start point once, with the time until the next fix", () => {
      const { points, weights } = heatmapPoints(segments, () => true, byTime);

      expect(points).toEqual([start, mid, other]);
      // In units of 4 s, about the pace a flight logger writes fixes at
      expect(weights[0]).toBe(2);
      // The last of a flight and one without times take their length at
      // their groundspeed
      expect(weights[1]).toBeCloseTo(
        segmentSeconds(segments[1]!, undefined) / 4,
      );
      expect(weights[2]).toBeCloseTo(
        segmentSeconds(segments[2]!, undefined) / 4,
      );
    });

    it("weighs a flight by the time it took, not by how often its logger wrote", () => {
      // The same 20 s, logged every 2 s and every 5 s
      const logged = (pathId: number, step: number): typeof segments =>
        Array.from({ length: 20 / step }, (_, i) =>
          createSegment({
            path_id: pathId,
            coords: [
              [50 + (i * step) / 1000, 8],
              [50 + ((i + 1) * step) / 1000, 8],
            ],
            time: i * step,
          }),
        );
      /** The heat of all but the last fix, whose time is its speed's */
      const heat = (list: typeof segments): number =>
        heatmapPoints(list, () => true, byTime)
          .weights.slice(0, -1)
          .reduce((a, b) => a + b, 0);

      const often = logged(1, 2);
      const seldom = logged(2, 5);
      expect(heat(often)).toBeCloseTo(18 / 4);
      expect(heat(seldom)).toBeCloseTo(15 / 4);
      // Counted by the fix, the one would weigh 9 and the other 3
    });

    it("keeps only the paths the filter accepts", () => {
      expect(heatmapPoints(segments, (id) => id === 2, byTime).points).toEqual([
        other,
      ]);
      expect(heatmapPoints(segments, () => false, byTime)).toEqual({
        points: [],
        weights: [],
      });
    });

    it("leaves out the points of no heat", () => {
      const taxi = createSegment({
        path_id: 3,
        coords: [start, mid],
        time: 0,
        groundspeed_knots: 10,
      });
      const climb = createSegment({
        path_id: 3,
        coords: [mid, end],
        time: 30,
        groundspeed_knots: 70,
      });

      expect(heatmapPoints([taxi, climb], () => true, byTime).points).toEqual([
        start,
        mid,
      ]);
      expect(
        heatmapPoints(
          [taxi, climb],
          () => true,
          (segment, next) =>
            segment.groundspeed_knots < 30 ? 0 : byTime(segment, next),
        ).points,
      ).toEqual([mid]);
    });
  });

  describe("applyHeatmapEmphasis", () => {
    /** The opacity of the heatmap before it fades out for the heat lines */
    const opacity = (): unknown =>
      (heatLayer().paint["heatmap-opacity"] as unknown[])[4];
    /**
     * The opacities of a heat line layer once faded in: one, or one per
     * heat where it depends on the heat
     */
    const strengths = (value: unknown): number[] => {
      const faded = (value as unknown[])[6];
      if (typeof faded === "number") return [faded];
      return (faded as unknown[])
        .slice(3)
        .filter((_, i) => i % 2 === 1) as number[];
    };
    const lineOpacity = (id: string): number[] =>
      strengths(mockApp.map!.layer(id).paint["line-opacity"]);
    const fullLineOpacity = (id: string): number[] =>
      strengths(
        heatLinesPaint()[id as keyof ReturnType<typeof heatLinesPaint>][
          "line-opacity"
        ],
      );

    it("steps the heatmap back while a colour layer is over it", () => {
      mockApp.altitudeVisible = true;
      mockApp.currentData = baseData();

      expect(opacity()).toBe(0.35);
      // And the heat lines it hands over to, as far
      for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
        const full = fullLineOpacity(id);
        lineOpacity(id).forEach((value, i) => {
          expect(value).toBeCloseTo(full[i]! * 0.35);
        });
      }
    });

    it("brings it back to full strength on its own", () => {
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      mockApp.currentData = baseData();

      expect(opacity()).toBe(1);
      for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
        expect(lineOpacity(id)).toEqual(fullLineOpacity(id));
      }
    });

    it("follows the speed layer too", () => {
      mockApp.currentData = baseData();
      expect(opacity()).toBe(1);

      mockApp.airspeedVisible = true;
      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.35);

      mockApp.airspeedVisible = false;
      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(1);
    });

    it("steps back under the lines of a selection, and only while they show", () => {
      mockApp.currentData = baseData();
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      dataManager.applyHeatmapEmphasis();
      expect(opacity()).toBe(0.35);

      // A replay hides the lines (and the heatmap): no dimming for them
      mockApp.replayActive = true;
      dataManager.applyHeatmapEmphasis();
      expect(opacity()).toBe(1);

      mockApp.replayActive = false;
      mockApp.selectedPathIds = new Set();
      dataManager.applyHeatmapEmphasis();
      expect(opacity()).toBe(1);
    });

    it("takes how far from the stylesheet's token", () => {
      document.documentElement.style.setProperty(
        "--heatmap-dimmed-opacity",
        " 0.5 ",
      );
      mockApp.altitudeVisible = true;

      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.5);
    });

    it.each(["", "none", "7", "-1"])(
      "falls back to 0.35 for a token of '%s'",
      (value) => {
        document.documentElement.style.setProperty(
          "--heatmap-dimmed-opacity",
          value,
        );
        mockApp.altitudeVisible = true;

        dataManager.applyHeatmapEmphasis();

        expect(opacity()).toBe(0.35);
      },
    );

    it("dims a hidden heatmap too, so it is right when it is shown", () => {
      mockApp.heatmapVisible = false;
      mockApp.altitudeVisible = true;

      dataManager.applyHeatmapEmphasis();

      expect(opacity()).toBe(0.35);
      expect(heatLayer().layout["visibility"]).toBe("none");
    });

    /** The opacity the paint of layer `id` gives at `zoom`, hot lines */
    const at = (id: string, property: string, zoom: number): number => {
      const parsed = createExpression(
        mockApp.map!.layer(id).paint[property],
        "paint.opacity",
        { type: "number" } as StylePropertySpecification,
      );
      if (parsed.result !== "success") throw new Error("not an expression");
      return parsed.value.evaluate(
        { zoom },
        { type: "LineString", properties: { heat: 1e6 } },
      ) as number;
    };

    it("dims the heat across the aviation chart's band, by zoom", () => {
      // Set once the map came to rest, the dimming lagged the chart
      // through a pinch: the paint follows the zoom itself now
      mockApp.currentData = baseData();
      mockApp.aviationVisible = true;
      dataManager.applyHeatmapEmphasis();

      const heat = (zoom: number): number =>
        at(MAP_LAYERS.heat, "heatmap-opacity", zoom);
      const [from, to] = AVIATION_BAND;
      // Full strength below the band, dimmed across it, the hand-over to
      // the lines as before
      expect(heat(from - 0.01)).toBe(1);
      expect(heat(from)).toBeCloseTo(0.35);
      expect(heat(9)).toBeCloseTo(0.35);
      expect(heat(HEAT_LINES.midZoom)).toBeCloseTo(0.35);
      expect(heat((HEAT_LINES.midZoom + HEAT_LINES.fullZoom) / 2)).toBeCloseTo(
        0.35 / 2,
      );
      const glow = (zoom: number): number =>
        at(MAP_LAYERS.heatLinesGlow, "line-opacity", zoom);
      mockApp.aviationVisible = false;
      dataManager.applyHeatmapEmphasis();
      const full = [12, to - 0.01, to + 0.5].map(glow);
      mockApp.aviationVisible = true;
      dataManager.applyHeatmapEmphasis();
      expect(glow(12)).toBeCloseTo(full[0]! * 0.35);
      expect(glow(to - 0.01)).toBeCloseTo(full[1]! * 0.35);
      // Above the band, at full strength again
      expect(glow(to + 0.5)).toBeCloseTo(full[2]!);

      // A colour layer dims it at every zoom
      mockApp.altitudeVisible = true;
      dataManager.applyHeatmapEmphasis();
      expect(heat(from - 1)).toBeCloseTo(0.35);
      expect(opacity()).toBe(0.35);
    });

    it("dims the cores of the heat lines where the map comes to rest", () => {
      // A paint by zoom and by the heat of a line is worked out by MapLibre
      // at the whole zoom of its tile and the one after, and blended
      // between them: dimmed by zoom across the chart's band, which ends
      // just past 13, the cores were dimmed at rest above it up to 14
      mockApp.currentData = baseData();
      mockApp.aviationVisible = true;
      /** The opacity of a hot core at `zoom` as MapLibre draws it */
      const drawn = (zoom: number): number => {
        const tile = Math.floor(zoom);
        const core = (z: number): number =>
          at(MAP_LAYERS.heatLinesCore, "line-opacity", z);
        return core(tile) + (zoom - tile) * (core(tile + 1) - core(tile));
      };
      const [, to] = AVIATION_BAND;
      mockApp.aviationInView = false;
      dataManager.applyHeatmapEmphasis();
      const full = drawn(to + 0.5);
      expect(full).toBeGreaterThan(0.5);
      mockApp.aviationVisible = false;
      dataManager.applyHeatmapEmphasis();
      expect(drawn(to + 0.5)).toBeCloseTo(full);

      // Within the band, at rest
      mockApp.aviationVisible = true;
      mockApp.aviationInView = true;
      dataManager.applyHeatmapEmphasis();
      expect(drawn(to + 0.5)).toBeCloseTo(full * 0.35);
      expect(drawn(12.5)).toBeCloseTo(full * 0.35);
    });

    it("does nothing without a map or before the layers exist", () => {
      mockApp.map!.removeLayer(MAP_LAYERS.heat);
      expect(() => dataManager.applyHeatmapEmphasis()).not.toThrow();
      expect(mockApp.map!.setPaintProperty).not.toHaveBeenCalled();

      mockApp.map = null;
      expect(() => dataManager.applyHeatmapEmphasis()).not.toThrow();
    });
  });
});
