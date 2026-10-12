import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
  type Mock,
} from "vitest";
// jsdom has no streams; Node's are the ones its Response is built on
import {
  ReadableStream as NodeReadableStream,
  TransformStream as NodeTransformStream,
} from "node:stream/web";
import {
  isValidYear,
  fetchBytes,
  fetchJson,
  importYearTools,
  DataLoader,
  type DataLoaderOptions,
} from "../../../../flown/frontend/services/dataLoader";
import {
  resetSiteData,
  siteData,
} from "../../../../flown/frontend/state/siteData";
import { logDebug, logError } from "../../../../flown/frontend/utils/logger";
import { createYearDecoder } from "../../../../flown/frontend/services/yearDecoder";
import { FakeYearWorker, path, rawYear, yearBytes } from "../../yearFixtures";
import type {
  LoadingState,
  Metadata,
  RawYearData,
} from "../../../../flown/frontend/types";

// Mock logger
vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

describe("fetchJson", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches the URL and returns the parsed body", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"a":1}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("data/test.json")).resolves.toEqual({ a: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("data/test.json");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects on an error status, which says more than a script tag did", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("", { status: 404 })),
    );

    const failure = await fetchJson("bad.json").catch((e: unknown) => e);

    expect(failure).toEqual(new Error("Failed to load bad.json"));
    expect((failure as Error).cause).toEqual(new Error("HTTP 404"));
  });

  it("rejects when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );

    await expect(fetchJson("bad.json")).rejects.toThrow(
      "Failed to load bad.json",
    );
  });

  it("rejects on a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("<html>", { status: 200 })),
    );

    await expect(fetchJson("page.json")).rejects.toThrow(
      "Failed to load page.json",
    );
  });

  it("aborts a request that neither answers nor fails", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signal = init!.signal!;
        return new Promise((_resolve, reject) => {
          signal!.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );

    const pending = fetchJson("stalled.json", { timeoutMs: 5000 });
    const outcome = expect(pending).rejects.toThrow(
      "Timed out loading stalled.json",
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(signal!.aborted).toBe(true);
  });

  it("does not leave the timer running once the file has loaded", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("[]")),
    );

    await fetchJson("fast.json", { timeoutMs: 10 });

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchJson with a progress callback", () => {
  beforeEach(() => {
    vi.stubGlobal("TransformStream", NodeTransformStream);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const encoder = new TextEncoder();

  /** A body whose source is written out by the test */
  function streamOf(
    start: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  ): ReadableStream<Uint8Array> {
    return new NodeReadableStream<Uint8Array>({
      start,
    }) as ReadableStream<Uint8Array>;
  }

  /** A 200 whose body arrives in the given pieces */
  function chunked(chunks: Uint8Array[]): Response {
    return new Response(
      streamOf((controller) => {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }),
    );
  }

  function stubFetch(response: Response): void {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
  }

  it("reports every chunk, ending at the size of the body", async () => {
    const body = JSON.stringify({ name: "Zürich", values: [1, 2, 3] });
    const bytes = encoder.encode(body);
    // The second cut falls inside the two bytes of the ü, which only a
    // decoder that carries state across chunks puts back together
    const cut = bytes.indexOf(0xc3) + 1;
    stubFetch(
      chunked([bytes.slice(0, 5), bytes.slice(5, cut), bytes.slice(cut)]),
    );
    const onProgress = vi.fn<(loadedBytes: number) => void>();

    const parsed = await fetchJson("data/2025/data.json", { onProgress });

    expect(parsed).toEqual({ name: "Zürich", values: [1, 2, 3] });
    const reported = onProgress.mock.calls.map(([loaded]) => loaded);
    expect(reported).toEqual([5, cut, bytes.length]);
    // Bytes, not characters: the ü counts twice
    expect(bytes.length).toBe(body.length + 1);
  });

  it("counts the same way for a body that is fetched as bytes", async () => {
    const bytes = encoder.encode('{"a":1}');
    stubFetch(chunked([bytes.slice(0, 3), bytes.slice(3)]));
    const onProgress = vi.fn<(loadedBytes: number) => void>();

    const body = await fetchBytes("data/2025/data.json", { onProgress });

    expect(new Uint8Array(body)).toEqual(bytes);
    expect(onProgress.mock.calls.map(([loaded]) => loaded)).toEqual([3, 7]);
  });

  it("fetches bytes without counting when nobody asked for the count", async () => {
    stubFetch(new Response("{}"));

    await expect(fetchBytes("a.json")).resolves.toHaveProperty("byteLength", 2);
  });

  it("fails bytes like JSON: with the URL, and the status as the cause", async () => {
    stubFetch(new Response("", { status: 404 }));

    const failure = await fetchBytes("bad.json").catch((e: unknown) => e);

    expect(failure).toEqual(new Error("Failed to load bad.json"));
    expect((failure as Error).cause).toEqual(new Error("HTTP 404"));
  });

  it("reports nothing for an empty body, and fails on parsing it", async () => {
    stubFetch(chunked([]));
    const onProgress = vi.fn();

    await expect(fetchJson("empty.json", { onProgress })).rejects.toThrow(
      "Failed to load empty.json",
    );
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("parses a response without a body stream, reporting nothing", async () => {
    const response = new Response('{"a":1}');
    Object.defineProperty(response, "body", { value: null });
    stubFetch(response);
    const onProgress = vi.fn();

    await expect(fetchJson("a.json", { onProgress })).resolves.toEqual({
      a: 1,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("rejects on a body that is not JSON", async () => {
    stubFetch(chunked([encoder.encode("<html>")]));

    const failure = await fetchJson("page.json", { onProgress: vi.fn() }).catch(
      (e: unknown) => e,
    );

    expect(failure).toEqual(new Error("Failed to load page.json"));
    // Thrown by the parser of Node's Response, whose SyntaxError is not
    // the one of this realm
    expect(((failure as Error).cause as Error).name).toBe("SyntaxError");
  });

  it("parses the body natively where streams cannot be transformed", async () => {
    // jsdom has none of its own, so taking the stub away is enough
    vi.unstubAllGlobals();
    const response = chunked([encoder.encode('{"a":1}')]);
    const json = vi.spyOn(response, "json");
    stubFetch(response);
    const onProgress = vi.fn();

    await expect(fetchJson("a.json", { onProgress })).resolves.toEqual({
      a: 1,
    });
    expect(json).toHaveBeenCalledOnce();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("hands the body to the native parser when nobody counts", async () => {
    const response = chunked([encoder.encode('{"a":1}')]);
    const json = vi.spyOn(response, "json");
    stubFetch(response);

    await expect(fetchJson("a.json")).resolves.toEqual({ a: 1 });
    expect(json).toHaveBeenCalledOnce();
  });

  it("loads the file all the same when the progress callback throws", async () => {
    const bytes = encoder.encode('{"a":[1,2,3]}');
    stubFetch(chunked([bytes.slice(0, 4), bytes.slice(4, 8), bytes.slice(8)]));
    const onProgress = vi.fn<(loadedBytes: number) => void>(() => {
      throw new Error("no such element");
    });

    await expect(fetchJson("a.json", { onProgress })).resolves.toEqual({
      a: [1, 2, 3],
    });
    // Asked once, and left alone after it failed
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(4);
    expect(logError).toHaveBeenCalledWith(
      "Progress callback failed:",
      new Error("no such element"),
    );
  });

  it("rejects on an error status without reading the body", async () => {
    stubFetch(new Response("not found", { status: 404 }));
    const onProgress = vi.fn();

    const failure = await fetchJson("bad.json", { onProgress }).catch(
      (e: unknown) => e,
    );

    expect(failure).toEqual(new Error("Failed to load bad.json"));
    expect((failure as Error).cause).toEqual(new Error("HTTP 404"));
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("rejects when the connection breaks halfway through the body", async () => {
    stubFetch(
      new Response(
        streamOf((controller) => {
          controller.enqueue(encoder.encode('{"a":'));
          controller.error(new TypeError("network error"));
        }),
      ),
    );
    const onProgress = vi.fn();

    await expect(fetchJson("cut.json", { onProgress })).rejects.toThrow(
      "Failed to load cut.json",
    );
  });

  it("aborts a body that stalls after its first chunk", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signal = init!.signal!;
        return Promise.resolve(
          new Response(
            streamOf((controller) => {
              controller.enqueue(encoder.encode('{"a":'));
              // What the browser does to the body of an aborted fetch
              signal!.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            }),
          ),
        );
      }),
    );
    const onProgress = vi.fn();

    const pending = fetchJson("stalled.json", {
      timeoutMs: 5000,
      onProgress,
    });
    const outcome = expect(pending).rejects.toThrow(
      "Timed out loading stalled.json",
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(5);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isValidYear", () => {
  it("accepts 'all' and 4-digit years in range", () => {
    expect(isValidYear("all")).toBe(true);
    expect(isValidYear("2000")).toBe(true);
    expect(isValidYear("2099")).toBe(true);
  });

  it("accepts any four-digit year", () => {
    expect(isValidYear("1999")).toBe(true);
    expect(isValidYear("2100")).toBe(true);
  });

  it("rejects anything that is not four digits", () => {
    expect(isValidYear("abc")).toBe(false);
    expect(isValidYear("../etc")).toBe(false);
    expect(isValidYear("20255")).toBe(false);
    expect(isValidYear("2025/..")).toBe(false);
  });
});

describe("DataLoader", () => {
  let loader: DataLoader;
  let mockFetchJson: Mock<NonNullable<DataLoaderOptions["fetchJson"]>>;
  /** What the site serves, by URL; anything else is a 404 */
  let files: Record<string, unknown>;
  let mockShowLoading: Mock<(state: LoadingState) => void>;
  let mockHideLoading: Mock<() => void>;
  let onLoadError: Mock<(years: string[]) => void>;
  let yearWorker: FakeYearWorker;
  let mockImportYearTools: Mock<typeof importYearTools>;

  function defineYear(
    year: number,
    segments: RawYearData["segments"] = {
      "1": path([50, 8], [[50.1, 8.1, 1000, 100, 0]]),
    },
  ): void {
    files[`test-data/${year}/data.json`] = rawYear(
      year,
      segments,
      [{ id: 1, year }],
      1,
    );
  }

  /** Metadata that knows these sizes, and the years they belong to */
  function withSizes(sizes: Record<string, number>): void {
    siteData.metadata = {
      available_years: Object.keys(sizes).map(Number),
      year_file_bytes: sizes,
    } as Metadata;
  }

  function serve(url: string): Promise<unknown> {
    return url in files
      ? Promise.resolve(files[url])
      : Promise.reject(new Error("HTTP 404"));
  }

  beforeEach(() => {
    resetSiteData();
    files = {};
    mockFetchJson = vi.fn<NonNullable<DataLoaderOptions["fetchJson"]>>();
    mockFetchJson.mockImplementation(serve);
    mockShowLoading = vi.fn();
    mockHideLoading = vi.fn();
    onLoadError = vi.fn();

    yearWorker = new FakeYearWorker();
    mockImportYearTools = vi.fn<typeof importYearTools>(() =>
      Promise.resolve({
        createYearDecoder: () =>
          createYearDecoder({ createWorker: () => yearWorker.asWorker() }),
      }),
    );

    loader = new DataLoader({
      dataDir: "test-data",
      fetchJson: mockFetchJson,
      // The year files are served by the same mock, as the bytes of the
      // JSON, so that a test can tell the site's files in one place
      fetchBytes: (url, options) => mockFetchJson(url, options).then(yearBytes),
      importYearTools: mockImportYearTools,
      showLoading: mockShowLoading,
      hideLoading: mockHideLoading,
      onLoadError,
    });
  });

  describe("input validation", () => {
    it("rejects invalid years without loading", async () => {
      expect(await loader.loadData("abc")).toBeNull();
      expect(await loader.loadData("../data")).toBeNull();
      expect(await loader.loadData("20255")).toBeNull();
      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(onLoadError).not.toHaveBeenCalled();
    });
  });

  describe("loadData", () => {
    it("loads and expands data for a specific year", async () => {
      defineYear(2025);

      const result = await loader.loadData("2025");

      expect(mockFetchJson).toHaveBeenCalledWith(
        "test-data/2025/data.json",
        undefined,
      );
      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
      expect(result!.path_segments[0]!.path_id).toBe(1);
      expect(mockShowLoading).toHaveBeenCalledTimes(1);
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("reports year and file size to the loading indicator", async () => {
      withSizes({ "2024": 100, "2025": 2048 });
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockShowLoading).toHaveBeenCalledExactlyOnceWith({
        operation: 1,
        all: false,
        years: ["2025"],
        fileBytes: 2048,
        loadedBytes: 0,
        totalBytes: 2048,
      });
    });

    it("reports the year without size when metadata is unavailable", async () => {
      defineYear(2025);

      await loader.loadData("2025");

      expect(mockShowLoading).toHaveBeenCalledExactlyOnceWith({
        operation: 1,
        all: false,
        years: ["2025"],
        fileBytes: undefined,
        loadedBytes: 0,
        totalBytes: undefined,
      });
    });

    it("uses cached data on second call", async () => {
      defineYear(2025);

      const first = await loader.loadData("2025");
      const second = await loader.loadData("2025");

      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it("hands out a year it holds without loading one it does not", async () => {
      defineYear(2025);
      expect(loader.cachedData("2025")).toBeUndefined();

      const data = await loader.loadData("2025");

      expect(loader.cachedData("2025")).toBe(data);
      expect(loader.cachedData("2024")).toBeUndefined();
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent loads of the same year", async () => {
      defineYear(2025);
      let answer: () => void = () => {};
      mockFetchJson.mockImplementationOnce(
        (url) =>
          new Promise((resolve) => {
            answer = () => resolve(files[url]);
          }),
      );

      const p1 = loader.loadData("2025");
      const p2 = loader.loadData("2025");
      answer();
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(r1).toBe(r2);
    });

    it("returns null and reports the year when the file fails to load", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("Failed to load"));

      const result = await loader.loadData("2025");

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2025"], false);
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("returns null when the file is not a year file", async () => {
      files["test-data/2025/data.json"] = null;

      const result = await loader.loadData("2025");

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2025"], false);
    });

    it("suggests a reload for a year file of another format", async () => {
      files["test-data/2025/data.json"] = { ...rawYear(2025, {}), format: 99 };

      expect(await loader.loadData("2025")).toBeNull();

      // A cached page next to newer data: the reload is what cures it
      expect(onLoadError).toHaveBeenCalledWith(["2025"], true);
    });

    it('defaults to "all" if year not specified', async () => {
      siteData.metadata = { available_years: [2025] } as Metadata;
      defineYear(2025);

      const result = await loader.loadData();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
    });

    it("does not cache failed loads", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("boom"));
      expect(await loader.loadData("2025")).toBeNull();

      defineYear(2025);
      expect(await loader.loadData("2025")).not.toBeNull();
      // The failure was not remembered: the file was requested again
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  describe("loadAndCombineAllYears", () => {
    it("loads and combines all years in parallel", async () => {
      siteData.metadata = { available_years: [2024, 2025] } as Metadata;
      defineYear(2024);
      defineYear(2025);

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(2);
      expect(result!.original_points).toBe(2);
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
      expect(onLoadError).not.toHaveBeenCalled();
    });

    it("loads metadata first when not present", async () => {
      files["test-data/metadata.json"] = { available_years: [2025] };
      defineYear(2025);

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(mockFetchJson).toHaveBeenCalledWith("test-data/metadata.json");
    });

    it("reports the total size of all year files", async () => {
      withSizes({ "2024": 100, "2025": 2048 });
      defineYear(2024);
      defineYear(2025);

      await loader.loadAndCombineAllYears();

      expect(mockShowLoading).toHaveBeenCalledWith({
        operation: 2,
        all: true,
        years: ["2024", "2025"],
        fileBytes: 2148,
        loadedBytes: 0,
        totalBytes: 2148,
      });
    });

    it("keeps the loading indicator visible until all years are loaded", async () => {
      siteData.metadata = { available_years: [2024, 2025] } as Metadata;
      defineYear(2024);
      defineYear(2025);
      const resolvers: (() => void)[] = [];
      mockFetchJson.mockImplementation(
        (url: string) =>
          new Promise((resolve) => {
            resolvers.push(() => resolve(files[url]));
          }),
      );

      const promise = loader.loadAndCombineAllYears();
      await Promise.resolve();
      expect(resolvers).toHaveLength(2);

      resolvers[0]!();
      await Promise.resolve();
      await Promise.resolve();
      expect(mockHideLoading).not.toHaveBeenCalled();

      resolvers[1]!();
      await promise;

      expect(mockHideLoading).toHaveBeenCalledTimes(1);
      // Nothing is shown again once the indicator is down
      expect(mockShowLoading.mock.invocationCallOrder.at(-1)).toBeLessThan(
        mockHideLoading.mock.invocationCallOrder[0]!,
      );
    });

    it("uses cached combined data", async () => {
      siteData.metadata = { available_years: [2025] } as Metadata;
      defineYear(2025);

      const first = await loader.loadAndCombineAllYears();
      const second = await loader.loadAndCombineAllYears();

      expect(second).toBe(first);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent 'all' loads", async () => {
      siteData.metadata = { available_years: [2025] } as Metadata;
      defineYear(2025);

      const [a, b] = await Promise.all([
        loader.loadData("all"),
        loader.loadData("all"),
      ]);

      expect(a).toBe(b);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it("returns null if metadata is missing", async () => {
      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("returns null if available_years is missing", async () => {
      siteData.metadata = {} as Metadata;

      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
    });

    it("returns partial data and reports the failed years", async () => {
      siteData.metadata = { available_years: [2024, 2025] } as Metadata;
      defineYear(2025);

      const result = await loader.loadAndCombineAllYears();

      expect(result).not.toBeNull();
      expect(result!.path_segments).toHaveLength(1);
      expect(result!.incomplete).toBe(true);
      expect(onLoadError).toHaveBeenCalledTimes(1);
      expect(onLoadError).toHaveBeenCalledWith(["2024"], false);
    });

    it("returns null and lists every year when all fail", async () => {
      siteData.metadata = { available_years: [2024, 2025] } as Metadata;
      mockFetchJson.mockRejectedValue(new Error("Network error"));

      const result = await loader.loadAndCombineAllYears();

      expect(result).toBeNull();
      expect(onLoadError).toHaveBeenCalledWith(["2024", "2025"], false);
      expect(mockHideLoading).toHaveBeenCalled();

      // Nothing was cached, so the next call tries the files again
      mockFetchJson.mockClear();
      expect(await loader.loadAndCombineAllYears()).toBeNull();
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  describe("download progress", () => {
    /** Per URL: report bytes as read, and let the request succeed or fail */
    let requests: Record<
      string,
      { read: (loadedBytes: number) => void; settle: (ok?: boolean) => void }
    >;

    beforeEach(() => {
      requests = {};
      mockFetchJson.mockImplementation((url, options) => {
        if (!url.endsWith("/data.json")) return serve(url);
        return new Promise((resolve, reject) => {
          requests[url] = {
            read: (loadedBytes) => options?.onProgress?.(loadedBytes),
            settle: (ok = true) =>
              ok ? resolve(files[url]) : reject(new Error("HTTP 500")),
          };
        });
      });
    });

    const request = (year: number): (typeof requests)[string] =>
      requests[`test-data/${year}/data.json`]!;

    /** What the indicator was told, as "years (size) loaded/total" */
    const shown = (): string[] =>
      mockShowLoading.mock.calls.map(
        ([{ all, years, fileBytes, loadedBytes, totalBytes }]) =>
          `${all ? "all:" : ""}${years.join("+")} (${fileBytes}) ` +
          `${loadedBytes}/${totalBytes}`,
      );

    /**
     * Let the promise chains of settled requests run: a year has arrived
     * once the year worker has answered and its dataset is built
     */
    const settled = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    it("reports the bytes of a year against its size on disk", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(400);
      request(2025).read(1000);
      request(2025).settle();
      await loading;

      // Nothing is reported for the file having settled: the indicator goes
      // away instead
      expect(shown()).toEqual([
        "2025 (1000) 0/1000",
        "2025 (1000) 400/1000",
        "2025 (1000) 1000/1000",
      ]);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("counts a file no further than its expected size, and never back", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(600);
      request(2025).read(500);
      request(2025).read(1500);
      request(2025).read(1600);
      request(2025).settle();
      await loading;

      expect(shown()).toEqual([
        "2025 (1000) 0/1000",
        "2025 (1000) 600/1000",
        // Once: the chunks past the size change nothing on screen
        "2025 (1000) 1000/1000",
      ]);
      // Said once, not for every chunk past the size
      expect(
        vi
          .mocked(logDebug)
          .mock.calls.filter(([message]) => String(message).includes("larger")),
      ).toEqual([
        ["Year file is larger than metadata.year_file_bytes says:", 1000],
      ]);
    });

    it.each([
      ["without metadata", undefined],
      ["for a year the metadata has no size for", { "2024": 10 }],
      ["for a size of zero", { "2025": 0 }],
    ])("asks for no byte counts %s", async (_name, sizes) => {
      if (sizes) withSizes(sizes);
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).settle();
      await loading;

      expect(mockFetchJson).toHaveBeenCalledExactlyOnceWith(
        "test-data/2025/data.json",
        undefined,
      );
      expect(shown()).toEqual(["2025 (undefined) 0/undefined"]);
    });

    it("sums the years of 'all' into one share", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      request(2025).read(150);
      request(2024).read(60);
      request(2024).settle();
      await settled();
      request(2025).read(300);
      request(2025).settle();
      await loading;

      // The first three are one frame to the indicator, which draws the last
      expect(shown()).toEqual([
        "all: (undefined) 0/undefined",
        "all:2024 (100) 0/100",
        "all:2024+2025 (400) 0/400",
        "all:2024+2025 (400) 150/400",
        "all:2024+2025 (400) 210/400",
        // Arrived, so it counts in full whatever was counted on the way
        "all:2024+2025 (400) 250/400",
        "all:2024+2025 (400) 400/400",
        "all:2024+2025 (400) 400/400",
      ]);
    });

    it("shows no share while one size of 'all' is unknown", async () => {
      withSizes({ "2024": 100 });
      siteData.metadata!.available_years = [2024, 2025];
      defineYear(2024);
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      request(2024).read(50);
      request(2024).settle();
      request(2025).settle();
      await loading;

      expect(new Set(shown().slice(2))).toEqual(
        new Set(["all:2024+2025 (undefined) 0/undefined"]),
      );
    });

    it("starts over without a year that failed, counting no bytes that never arrived", async () => {
      withSizes({ "2023": 100, "2024": 100, "2025": 300 });
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(3));
      mockShowLoading.mockClear();
      request(2025).read(150);
      request(2024).read(20);
      request(2023).settle(false);
      request(2024).settle(false);
      await settled();
      request(2025).read(225);
      request(2025).settle();
      await loading;

      expect(shown()).toEqual([
        "all:2023+2024+2025 (500) 150/500",
        "all:2023+2024+2025 (500) 170/500",
        // What is left: 80 bytes of 2024 and the half of 2025 still to come.
        // The size is that of the whole files, as the label names them.
        "all:2024+2025 (400) 0/230",
        "all:2025 (300) 0/150",
        "all:2025 (300) 75/150",
        "all:2025 (300) 150/150",
      ]);
      expect(onLoadError).toHaveBeenCalledWith(["2023", "2024"], false);
    });

    it("starts over when another year joins, with what is still to come", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);

      const first = loader.loadData("2025");
      request(2025).read(270);
      const second = loader.loadData("2024");
      request(2025).read(285);
      request(2025).settle();
      await first;
      request(2024).read(50);
      request(2024).settle();
      await second;

      expect(shown()).toEqual([
        "2025 (300) 0/300",
        "2025 (300) 270/300",
        // Not 270 of 400: the bar is about the 130 bytes that the two files
        // still have to deliver, the label about the files
        "2025+2024 (400) 0/130",
        "2025+2024 (400) 15/130",
        "2025+2024 (400) 30/130",
        "2025+2024 (400) 80/130",
      ]);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("leaves a settled year out of the load that joins after it", async () => {
      withSizes({ "2023": 50, "2024": 100, "2025": 300 });
      defineYear(2023);
      defineYear(2024);
      defineYear(2025);

      const first = loader.loadData("2025");
      const second = loader.loadData("2024");
      request(2025).read(300);
      request(2025).settle();
      await first;
      mockShowLoading.mockClear();
      const third = loader.loadData("2023");
      request(2024).settle();
      request(2023).settle();
      await Promise.all([second, third]);

      expect(shown()[0]).toBe("2024+2023 (150) 0/150");
    });

    it("leaves a cached year out of label and bar alike", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);
      const first = loader.loadData("2024");
      request(2024).settle();
      await first;
      mockShowLoading.mockClear();

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(requests["test-data/2025/data.json"]));
      request(2025).read(150);
      request(2025).settle();
      await loading;

      expect(shown()).toEqual([
        "all: (undefined) 0/undefined",
        "all:2025 (300) 0/300",
        "all:2025 (300) 150/300",
        "all:2025 (300) 300/300",
      ]);
    });

    it.each(["showLoading", "hideLoading"] as const)(
      "finishes the load when %s throws",
      async (callback) => {
        withSizes({ "2024": 100, "2025": 300 });
        defineYear(2024);
        defineYear(2025);
        const broken =
          callback === "showLoading" ? mockShowLoading : mockHideLoading;
        broken.mockImplementation(() => {
          throw new Error("no such element");
        });

        const loading = loader.loadAndCombineAllYears();
        await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
        request(2024).read(50);
        request(2024).settle();
        request(2025).settle();

        const data = await loading;
        expect(data!.path_segments).toHaveLength(2);
        expect(onLoadError).not.toHaveBeenCalled();
        // The count of loads came out even: the indicator was taken down
        expect(mockHideLoading).toHaveBeenCalledOnce();
        expect(logError).toHaveBeenCalledWith(
          "Loading indicator failed:",
          new Error("no such element"),
        );
      },
    );

    it("lets go of a year that every caller gave up on, and caches it all the same", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);
      const cached = loader.loadData("2024");
      request(2024).settle();
      await cached;
      mockShowLoading.mockClear();
      mockHideLoading.mockClear();

      // A slow 2025, then a switch to the cached 2024
      const controller = new AbortController();
      const slow = loader.loadData("2025", controller.signal);
      request(2025).read(100);
      controller.abort();
      await loader.loadData("2024");

      expect(shown()).toEqual(["2025 (300) 0/300", "2025 (300) 100/300"]);
      expect(mockHideLoading).toHaveBeenCalledOnce();

      // The rest of the file says nothing, and ends up in the cache
      request(2025).read(200);
      request(2025).settle();
      expect(await slow).not.toBeNull();
      expect(mockShowLoading).toHaveBeenCalledTimes(2);
      expect(mockHideLoading).toHaveBeenCalledOnce();
      await loader.loadData("2025");
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it("shows a given-up year again for the caller that comes back to it", async () => {
      withSizes({ "2025": 300 });
      defineYear(2025);

      const controller = new AbortController();
      void loader.loadData("2025", controller.signal);
      controller.abort();
      const again = loader.loadData("2025");
      request(2025).settle();
      await again;

      expect(shown()).toEqual(["2025 (300) 0/300", "2025 (300) 0/300"]);
      expect(mockHideLoading).toHaveBeenCalledTimes(2);
    });

    it("keeps a year up while one of its callers still waits", async () => {
      withSizes({ "2025": 300 });
      defineYear(2025);

      const controller = new AbortController();
      void loader.loadData("2025", controller.signal);
      const other = loader.loadData("2025", new AbortController().signal);
      controller.abort();

      expect(mockHideLoading).not.toHaveBeenCalled();
      request(2025).settle();
      await other;
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("reports no failure of a year its caller gave up on", async () => {
      withSizes({ "2025": 300 });

      const controller = new AbortController();
      const loading = loader.loadData("2025", controller.signal);
      controller.abort();
      request(2025).settle(false);

      expect(await loading).toBeNull();
      expect(onLoadError).not.toHaveBeenCalled();
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("lets go of 'all' once every caller gave up on it, and says none of its failures", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2024);
      defineYear(2025);

      const controller = new AbortController();
      const loading = loader.loadData("all", controller.signal);
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      controller.abort();

      expect(mockHideLoading).toHaveBeenCalledOnce();
      request(2024).settle();
      request(2025).settle(false);
      expect(await loading).toBeNull();
      expect(onLoadError).not.toHaveBeenCalled();
      expect(mockHideLoading).toHaveBeenCalledOnce();

      // The year that arrived went into the cache all the same
      await loader.loadData("2024");
      expect(Object.keys(requests)).toHaveLength(2);
    });

    it("keeps 'all' up while one of its callers still waits", async () => {
      withSizes({ "2025": 300 });
      defineYear(2025);

      const controller = new AbortController();
      const first = loader.loadData("all", controller.signal);
      const second = loader.loadData("all", new AbortController().signal);
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(1));
      controller.abort();

      expect(mockHideLoading).not.toHaveBeenCalled();
      request(2025).settle();
      expect(await second).not.toBeNull();
      expect(await first).toBe(await second);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("does not hold 'all' up for a caller that gave up before it came", async () => {
      withSizes({ "2025": 300 });
      defineYear(2025);

      const controller = new AbortController();
      const waiting = loader.loadData("all", controller.signal);
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(1));
      const late = new AbortController();
      late.abort();
      expect(await loader.loadData("all", late.signal)).toBeNull();
      controller.abort();

      // The one caller that joined gave up, so the indicator lets go
      expect(mockHideLoading).toHaveBeenCalledOnce();
      request(2025).settle();
      expect(await waiting).toBeNull();
    });

    it("starts 'all' over for a caller that comes after every other gave up", async () => {
      withSizes({ "2025": 300 });
      defineYear(2025);

      const controller = new AbortController();
      const given = loader.loadData("all", controller.signal);
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(1));
      controller.abort();
      const again = loader.loadData("all");
      request(2025).settle();

      expect(await given).toBeNull();
      expect(await again).not.toBeNull();
      // One request for the file, which both loads waited for
      expect(Object.keys(requests)).toHaveLength(1);
      expect(mockHideLoading).toHaveBeenCalledTimes(2);
    });

    it("lets go of 'all' given up on while its index loads", async () => {
      defineYear(2025);
      files["test-data/metadata.json"] = {
        available_years: [2025],
        year_file_bytes: { "2025": 300 },
      };

      const controller = new AbortController();
      const loading = loader.loadData("all", controller.signal);
      controller.abort();

      expect(await loading).toBeNull();
      expect(Object.keys(requests)).toHaveLength(0);
      expect(mockHideLoading).toHaveBeenCalled();
    });

    it("counts the operations: one more for every load that joins or fails", async () => {
      withSizes({ "2024": 100, "2025": 100 });
      defineYear(2025);

      const first = loader.loadData("2025");
      request(2025).read(50);
      // Y2 joins with as many bytes as Y1 still lacks: nothing but the
      // count tells this operation from the last
      const second = loader.loadData("2024");
      request(2024).settle(false);
      await second;
      request(2025).read(60);
      request(2025).settle();
      await first;

      expect(
        mockShowLoading.mock.calls.map(
          ([{ operation, loadedBytes, totalBytes }]) =>
            `${operation}: ${loadedBytes}/${totalBytes}`,
        ),
      ).toEqual(["1: 0/100", "1: 50/100", "2: 0/150", "3: 0/50", "3: 10/50"]);
    });

    it("keeps the bar full when a failure leaves nothing to download", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2025);

      const loading = loader.loadAndCombineAllYears();
      await vi.waitFor(() => expect(Object.keys(requests)).toHaveLength(2));
      mockShowLoading.mockClear();
      // All of 2025 is in and is being read when 2024 fails
      request(2025).read(300);
      request(2024).settle(false);
      await settled();
      request(2025).settle();
      await loading;

      // Nothing of the new operation is left to download: a total of zero,
      // which the indicator shows as a bar that stays full
      expect(shown()).toEqual([
        "all:2024+2025 (400) 300/400",
        "all:2025 (300) 0/0",
        "all:2025 (300) 0/0",
      ]);
    });

    it("ignores bytes reported for a download that is over", async () => {
      withSizes({ "2024": 100, "2025": 300 });
      defineYear(2025);

      const first = loader.loadData("2024");
      const second = loader.loadData("2025");
      request(2024).settle(false);
      await first;
      mockShowLoading.mockClear();
      // What a request that timed out may still do
      request(2024).read(80);
      request(2025).settle();
      await second;
      request(2025).read(400);

      expect(shown()).toEqual([]);
      expect(mockHideLoading).toHaveBeenCalledOnce();
    });

    it("says so when a file came out smaller than its recorded size", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(700);
      request(2025).settle();
      await loading;

      expect(logDebug).toHaveBeenCalledWith(
        "Year file is smaller than metadata.year_file_bytes says:",
        { size: 1000, received: 700 },
      );
    });

    it("has nothing to say about a file of the recorded size", async () => {
      withSizes({ "2025": 1000 });
      defineYear(2025);

      const loading = loader.loadData("2025");
      request(2025).read(1000);
      request(2025).settle();
      await loading;

      expect(logDebug).not.toHaveBeenCalledWith(
        expect.stringContaining("year_file_bytes"),
        expect.anything(),
      );
    });

    it("asks for no progress on the index files", async () => {
      files["test-data/metadata.json"] = { available_years: [] };
      files["test-data/airports.json"] = { airports: [] };

      await loader.loadMetadata();
      await loader.loadAirports();

      expect(mockFetchJson.mock.calls).toEqual([
        ["test-data/metadata.json"],
        ["test-data/airports.json"],
      ]);
      // A load of no year, with no size and no bar
      for (const [state] of mockShowLoading.mock.calls) {
        expect(state).toMatchObject({
          all: false,
          years: [],
          fileBytes: undefined,
          totalBytes: undefined,
        });
      }
    });

    it("shows the indicator while the index files come in, and no longer", async () => {
      let answer!: (json: unknown) => void;
      mockFetchJson.mockImplementationOnce(
        () => new Promise((resolve) => (answer = resolve)),
      );

      const metadata = loader.loadMetadata();

      // The page used to be an empty map until the first year was asked for
      expect(mockShowLoading).toHaveBeenCalledTimes(1);
      expect(mockHideLoading).not.toHaveBeenCalled();
      answer({ available_years: [2025] });
      await metadata;
      expect(mockHideLoading).toHaveBeenCalledTimes(1);

      // Once in, the index is not asked for again, nor shown as a load
      await loader.loadMetadata();
      expect(mockShowLoading).toHaveBeenCalledTimes(1);
    });

    it("keeps the indicator up from the index to the year it names", async () => {
      defineYear(2025);
      files["test-data/metadata.json"] = { available_years: [2025] };

      const all = loader.loadData("all");
      await vi.waitFor(() => expect(request(2025)).toBeDefined());
      request(2025).settle();
      await all;

      // One load throughout, the index within the load of all years
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
      expect(shown()[0]).toBe("all: (undefined) 0/undefined");
      expect(shown().at(-1)).toBe("all:2025 (undefined) 0/undefined");
    });

    it("takes the exported fetchJson as it is", () => {
      // One signature: the function is a valid option, with no adapter that
      // could put the callback where the timeout goes
      expect(() => new DataLoader({ fetchJson })).not.toThrow();
      expect(() => new DataLoader({ fetchBytes })).not.toThrow();
    });
  });

  describe("year worker", () => {
    it("decodes every year with one worker, imported once", async () => {
      defineYear(2024);
      defineYear(2025);
      files["test-data/metadata.json"] = { available_years: [2024, 2025] };

      const all = await loader.loadData("all");

      expect(all!.path_segments).toHaveLength(2);
      expect(mockImportYearTools).toHaveBeenCalledTimes(1);
      expect(mockImportYearTools).toHaveBeenCalledWith(0);
      expect(yearWorker.requests).toHaveLength(2);
      expect(logError).not.toHaveBeenCalled();
    });

    it("asks for the worker before the year file has arrived", async () => {
      let arrive: (raw: unknown) => void = () => {};
      mockFetchJson.mockReturnValue(
        new Promise((resolve) => (arrive = resolve)),
      );

      const loading = loader.loadData("2025");
      expect(mockImportYearTools).toHaveBeenCalledTimes(1);

      arrive(rawYear(2025, {}));
      await expect(loading).resolves.toMatchObject({ path_segments: [] });
    });

    it("decodes on the main thread when the worker fails, which the caller cannot tell", async () => {
      defineYear(2025);
      yearWorker.answers = false;

      const loading = loader.loadData("2025");
      await vi.waitFor(() => expect(yearWorker.requests).toHaveLength(1));
      yearWorker.emit("error", { message: "blocked" });

      expect((await loading)!.path_segments).toHaveLength(1);
      expect(onLoadError).not.toHaveBeenCalled();
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("fails the year when the bundle cannot be imported, and imports it under another URL next time", async () => {
      defineYear(2025);
      mockImportYearTools.mockRejectedValueOnce(new Error("404"));

      expect(await loader.loadData("2025")).toBeNull();

      expect(onLoadError).toHaveBeenCalledWith(["2025"], false);
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
      const [, failure] = vi.mocked(logError).mock.calls[0]!;
      expect(failure).toEqual(
        new Error("Could not load ./yearWorker.bundle.js"),
      );

      expect((await loader.loadData("2025"))!.path_segments).toHaveLength(1);
      expect(mockImportYearTools.mock.calls).toEqual([[0], [1]]);
    });

    it("gives up on an import that stalls, and asks for the same URL next time", async () => {
      vi.useFakeTimers();
      try {
        defineYear(2025);
        mockImportYearTools.mockReturnValueOnce(new Promise(() => {}));

        const loading = loader.loadData("2025");
        await vi.advanceTimersByTimeAsync(120_000);

        expect(await loading).toBeNull();
        expect(onLoadError).toHaveBeenCalledWith(["2025"], false);
        expect(mockHideLoading).toHaveBeenCalledTimes(1);
        const [, failure] = vi.mocked(logError).mock.calls[0]!;
        expect((failure as Error).cause).toEqual(
          new Error("Timed out loading ./yearWorker.bundle.js"),
        );

        expect((await loader.loadData("2025"))!.path_segments).toHaveLength(1);
        // Timed out is not failed: the module may still arrive under that URL
        expect(mockImportYearTools.mock.calls).toEqual([[0], [0]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("never asks the worker for a year whose download was given up on", async () => {
      mockFetchJson.mockRejectedValue(new Error("Timed out loading"));

      expect(await loader.loadData("2025")).toBeNull();

      expect(yearWorker.requests).toEqual([]);
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("ends the worker with the loader, and reports nothing to an app that is gone", async () => {
      defineYear(2025);
      yearWorker.answers = false;
      const loading = loader.loadData("2025");
      await vi.waitFor(() => expect(yearWorker.requests).toHaveLength(1));

      loader.destroy();

      expect(await loading).toBeNull();
      expect(yearWorker.terminate).toHaveBeenCalledTimes(1);
      expect(onLoadError).not.toHaveBeenCalled();
      // The indicator is still taken down, and the year can be asked for again
      expect(mockHideLoading).toHaveBeenCalledTimes(1);
    });

    it("reports no failed years of 'all' to an app that is gone", async () => {
      defineYear(2025);
      files["test-data/metadata.json"] = { available_years: [2025] };
      yearWorker.answers = false;
      const loading = loader.loadData("all");
      await vi.waitFor(() => expect(yearWorker.requests).toHaveLength(1));

      loader.destroy();

      expect(await loading).toBeNull();
      expect(onLoadError).not.toHaveBeenCalled();
    });

    it("starts no worker for a loader that ended while the bundle was imported", async () => {
      defineYear(2025);
      const create = vi.fn();
      let arrive: () => void = () => {};
      mockImportYearTools.mockReturnValue(
        new Promise((resolve) => {
          arrive = () => resolve({ createYearDecoder: create });
        }),
      );
      const loading = loader.loadData("2025");

      loader.destroy();
      arrive();

      expect(await loading).toBeNull();
      expect(create).not.toHaveBeenCalled();
    });

    it("can be destroyed before it loaded anything", () => {
      expect(() => loader.destroy()).not.toThrow();
      expect(mockImportYearTools).not.toHaveBeenCalled();
    });
  });

  describe("importYearTools", () => {
    it("imports the year worker's module", async () => {
      const tools = await importYearTools(0);

      expect(tools.createYearDecoder).toBe(createYearDecoder);
    });

    it("names the bundle itself after a failure, next to this module", async () => {
      // There is no bundle next to the sources, so this fails, and says
      // what it asked for; the e2e suite checks the retry against a site
      const failure = await importYearTools(2).catch((e: unknown) => e);

      expect(String(failure)).toContain("/yearWorker.bundle.js");
    });
  });

  describe("loadAirports", () => {
    it("loads airports data", async () => {
      const mockAirports = [
        { name: "EDDF", lat: 50.0, lon: 8.0 },
        { name: "EDDM", lat: 48.3, lon: 11.7 },
      ];

      files["test-data/airports.json"] = { airports: mockAirports };

      const result = await loader.loadAirports();

      expect(mockFetchJson).toHaveBeenCalledWith("test-data/airports.json");
      expect(result).toBe(mockAirports);
    });

    it("skips loading if already loaded", async () => {
      const mockAirports = [{ name: "EDDF", lat: 50, lon: 8 }];
      siteData.airports = mockAirports;

      const result = await loader.loadAirports();

      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(result).toBe(mockAirports);
    });

    it("returns null on error", async () => {
      // An empty list read as a site without airports, and nobody said
      // they were missing
      mockFetchJson.mockRejectedValueOnce(new Error("Failed"));

      const result = await loader.loadAirports();

      expect(result).toBeNull();
      expect(siteData.airports).toBeNull();
    });
    it("publishes the list and shares one request", async () => {
      const mockAirports = [{ name: "EDDF", lat: 50, lon: 8 }];
      files["test-data/airports.json"] = { airports: mockAirports };

      const [a, b] = await Promise.all([
        loader.loadAirports(),
        loader.loadAirports(),
      ]);

      expect(a).toBe(b);
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
      expect(siteData.airports).toEqual(mockAirports);
    });

    it.each([null, {}, { airports: [{ name: "EDDF" }] }])(
      "refuses airports.json that is not a list of airports: %j",
      async (json) => {
        files["test-data/airports.json"] = json;

        expect(await loader.loadAirports()).toBeNull();

        expect(siteData.airports).toBeNull();
        expect(logError).toHaveBeenCalledWith(
          "Error loading airports:",
          new Error("Unexpected contents of airports.json"),
        );
      },
    );

    it("asks again after a failure", async () => {
      expect(await loader.loadAirports()).toBeNull();

      files["test-data/airports.json"] = { airports: [] };
      await loader.loadAirports();

      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });

  describe("loadMetadata", () => {
    it("loads metadata", async () => {
      const mockMetadata = { available_years: [2024, 2025] };

      files["test-data/metadata.json"] = mockMetadata;

      const result = await loader.loadMetadata();

      expect(mockFetchJson).toHaveBeenCalledWith("test-data/metadata.json");
      expect(result).toBe(mockMetadata);
    });

    it("skips loading if already loaded", async () => {
      const mockMetadata = { available_years: [2025] };
      siteData.metadata = mockMetadata as Metadata;

      const result = await loader.loadMetadata();

      expect(mockFetchJson).not.toHaveBeenCalled();
      expect(result).toBe(mockMetadata);
    });

    it("returns null on error", async () => {
      mockFetchJson.mockRejectedValueOnce(new Error("Failed"));

      const result = await loader.loadMetadata();

      expect(result).toBeNull();
    });

    it("says once that it arrived, whoever asked for it", async () => {
      const onMetadata = vi.fn();
      const told = new DataLoader({
        dataDir: "test-data",
        fetchJson: mockFetchJson,
        onMetadata,
      });
      files["test-data/metadata.json"] = { available_years: [2025] };
      mockFetchJson.mockRejectedValueOnce(new Error("Failed"));
      await told.loadMetadata();
      expect(onMetadata).not.toHaveBeenCalled();

      // Two callers that share the request, as the first load and a load
      // of all years can
      await Promise.all([told.loadMetadata(), told.loadMetadata()]);
      await told.loadMetadata();

      expect(onMetadata).toHaveBeenCalledExactlyOnceWith(siteData.metadata);
    });

    it.each([null, [], { available_years: "2025" }])(
      "refuses metadata.json without the list of years: %j",
      async (json) => {
        files["test-data/metadata.json"] = json;

        expect(await loader.loadMetadata()).toBeNull();

        expect(siteData.metadata).toBeNull();
        expect(logError).toHaveBeenCalledWith(
          "Error loading metadata:",
          new Error("Unexpected contents of metadata.json"),
        );
      },
    );
  });

  describe("default options", () => {
    it("fetches from the data directory next to the page by default", async () => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify(
              rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1000, 100]]) }),
            ),
          ),
        );
      vi.stubGlobal("fetch", fetchMock);

      const result = await new DataLoader().loadData("2025");

      expect(result!.path_segments).toHaveLength(1);
      expect(fetchMock.mock.calls[0]![0]).toBe("data/2025/data.json");
    });

    it("publishes the metadata", async () => {
      const metadata = { available_years: [2025] };
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(metadata))),
      );

      await expect(new DataLoader().loadMetadata()).resolves.toEqual(metadata);

      expect(siteData.metadata).toEqual(metadata);
    });
  });
});
