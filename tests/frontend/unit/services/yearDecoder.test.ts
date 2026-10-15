import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createYearDecoder } from "../../../../flown/frontend/services/yearDecoder";
import {
  DATA_FORMAT_VERSION,
  expandYearData,
} from "../../../../flown/frontend/services/yearDecode";
import { logError } from "../../../../flown/frontend/utils/logger";
import { drawHeat } from "../../../../flown/frontend/services/heatSource";
import { heatColumns } from "../../../../flown/frontend/calculations/heatExposure";
import {
  heatLineFeatures,
  heatWeight,
} from "../../../../flown/frontend/calculations/heatLines";
import { heatLineTone } from "../../../../flown/frontend/calculations/heatTone";
import {
  flatRuns,
  flightColumns,
  flightsOf,
  runsSource,
} from "../../../../flown/frontend/services/flightLines";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createSegment } from "../../testHelpers";
import {
  dataset,
  FakeYearWorker,
  path,
  rawYear,
  yearBytes,
} from "../../yearFixtures";

vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

const year = rawYear(
  2025,
  { "1": path([50, 8], [[50.1, 8.1, 500, 100]]) },
  [{ id: 1 }],
  2,
);
const expanded = expandYearData(year);

describe("createYearDecoder", () => {
  let worker: FakeYearWorker;
  const createWorker = vi.fn(() => worker.asWorker());

  beforeEach(() => {
    worker = new FakeYearWorker();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts one worker, at once, and asks it for every year", async () => {
    const decoder = createYearDecoder({ createWorker });
    expect(createWorker).toHaveBeenCalledTimes(1);

    const [first, second] = await Promise.all([
      decoder.decode(yearBytes(year)),
      decoder.decode(yearBytes(year)),
    ]);

    expect(first).toEqual(expanded);
    expect(second).toEqual(expanded);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.requests.map((request) => request.id)).toEqual([0, 1]);
    expect(logError).not.toHaveBeenCalled();
  });

  it("keeps the bytes it sent, so that they can be decoded here after all", async () => {
    const decoder = createYearDecoder({ createWorker });
    const bytes = yearBytes(year);
    const postMessage = vi.spyOn(worker, "postMessage");

    await decoder.decode(bytes);

    // Nothing handed over: a transferred buffer would be empty on this side
    expect(postMessage).toHaveBeenCalledWith({ id: 0, bytes }, []);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("warns about the broken paths the worker reports", async () => {
    const broken = path([50, 8], [[50.1, 8.1, 500, 100]]);
    (broken.columns[0] as unknown[])[0] = "x";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const decoder = createYearDecoder({ createWorker });

    const data = await decoder.decode(
      yearBytes(rawYear(2025, { "1": broken })),
    );

    expect(data.path_segments).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Path 1: row 0 is not numeric, dropped the rest",
    );
    warn.mockRestore();
  });

  it("combines years like combineYearData", () => {
    const decoder = createYearDecoder({ createWorker });

    expect(decoder.combine([dataset(2), null]).path_segments).toHaveLength(2);
  });

  describe("fallback to the main thread", () => {
    it("decodes here where there are no workers", async () => {
      vi.stubGlobal("Worker", undefined);
      const decoder = createYearDecoder();

      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(logError).toHaveBeenCalledWith(
        "Year worker failed, decoding on the main thread:",
        expect.any(Error),
      );
    });

    it("starts the worker from the URL of its own module", () => {
      const WorkerStub = vi.fn(function () {
        return worker;
      });
      vi.stubGlobal("Worker", WorkerStub);

      createYearDecoder();

      expect(WorkerStub).toHaveBeenCalledWith(
        expect.stringMatching(/yearDecoder/),
        { type: "module" },
      );
    });

    it("decodes here once the worker reports an error, the years it still owed included", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.emit("error", { message: "script did not load" });

      await expect(owed).resolves.toEqual(expanded);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        "Year worker failed, decoding on the main thread:",
        "script did not load",
      );
      // Not asked again for the rest of the visit
      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.requests).toHaveLength(1);
      expect(createWorker).toHaveBeenCalledTimes(1);
    });

    it("gives up on the worker once, however many errors it reports", () => {
      const decoder = createYearDecoder({ createWorker });

      worker.emit("error", { message: "first" });
      worker.emit("messageerror", {});

      expect(logError).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      decoder.destroy();
    });

    it("decodes here when an answer cannot be read", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.emit("messageerror", {});

      await expect(owed).resolves.toEqual(expanded);
    });

    it("decodes here when the request cannot be posted", async () => {
      vi.spyOn(worker, "postMessage").mockImplementation(() => {
        throw new Error("DataCloneError");
      });
      const decoder = createYearDecoder({ createWorker });

      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    });

    it("decodes here when the worker does not answer in time", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker, timeoutMs: 1000 });
      const owed = decoder.decode(yearBytes(year));

      await vi.advanceTimersByTimeAsync(999);
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(owed).resolves.toEqual(expanded);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("waits for a queue the worker works through, one answer at a time", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker, timeoutMs: 1000 });
      const first = decoder.decode(yearBytes(year));
      const second = decoder.decode(yearBytes(year));

      await vi.advanceTimersByTimeAsync(900);
      worker.answer(worker.requests[0]!);
      await vi.advanceTimersByTimeAsync(900);
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.answer(worker.requests[1]!);

      await expect(first).resolves.toEqual(expanded);
      await expect(second).resolves.toEqual(expanded);
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("gives up on a queue when no answer comes for the whole wait", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker, timeoutMs: 1000 });
      const first = decoder.decode(yearBytes(year));
      await vi.advanceTimersByTimeAsync(500);
      const second = decoder.decode(yearBytes(year));

      // A later request does not put the deadline off
      await vi.advanceTimersByTimeAsync(500);

      expect(worker.terminate).toHaveBeenCalledTimes(1);
      await expect(first).resolves.toEqual(expanded);
      await expect(second).resolves.toEqual(expanded);
    });

    it("waits half a minute for an answer by default", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(owed).resolves.toEqual(expanded);
    });

    it("decodes a year the worker failed over again, and keeps the worker", async () => {
      const decoder = createYearDecoder({ createWorker });
      const bad = decoder.decode(yearBytes(null));

      // The error itself, not the text the worker sent
      await expect(bad).rejects.toThrow(/expected an object/);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not decode:",
        expect.stringContaining("expected an object"),
      );
      expect(worker.terminate).not.toHaveBeenCalled();
      await expect(decoder.decode(yearBytes(year))).resolves.toEqual(expanded);
      expect(worker.requests).toHaveLength(2);
    });

    it("takes a file of another release from the worker, without reading it again", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      // Bytes the page could read: it does not, as the worker's answer is
      // the file's, which only another release would read
      const stale = decoder.decode(yearBytes(year));

      worker.say({
        id: 0,
        error: "format 5, expected 6; written by another release",
        name: "StaleDataError",
        format: DATA_FORMAT_VERSION,
      });

      await expect(stale).rejects.toMatchObject({
        name: "StaleDataError",
        message: expect.stringContaining("another release") as string,
      });
      expect(logError).not.toHaveBeenCalled();
    });

    it("decodes here when a worker of another deploy calls the file stale", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      // The worker's script is newer than the page and its year file
      const owed = decoder.decode(yearBytes(year));

      worker.say({
        id: 0,
        error: "written by another release",
        name: "StaleDataError",
        format: DATA_FORMAT_VERSION + 1,
      });

      await expect(owed).resolves.toEqual(expanded);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not decode:",
        "written by another release",
      );
    });

    it("decodes here when the worker failed over a file that is fine", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.decode(yearBytes(year));

      worker.say({
        id: 0,
        error: "out of memory",
        name: "RangeError",
        format: DATA_FORMAT_VERSION,
      });

      await expect(owed).resolves.toEqual(expanded);
    });
  });

  describe("the heat sources", () => {
    const points: [number, number][] = [
      [50, 8],
      [50.01, 8.01],
      [50.02, 8.02],
    ];
    const weights = [1, 2, 0.5];
    const segments = [0, 1, 2].map((i) =>
      createSegment({
        path_id: 1,
        time: i * 4,
        coords: [
          [50 + i / 100, 8 + i / 100],
          [50 + (i + 1) / 100, 8 + (i + 1) / 100],
        ],
      }),
    );
    const runs = [{ start: 0, end: 2, pathId: 1, color: "#123456" }];

    /** The text of the heat lines of all of `of` at an exposure of 2 */
    const heatLinesOf = (of: readonly PathSegment[]): string =>
      JSON.stringify(
        heatLineFeatures(
          of,
          () => true,
          (segment, next) => heatWeight(segment, next) * 2,
          heatLineTone,
        ),
        (key, value: unknown) =>
          key === "coordinates"
            ? (value as number[][]).map((position) =>
                position.map((degrees) => Math.round(degrees * 1e7) / 1e7),
              )
            : value,
      );

    /** The text of the lines of `runs` along `of` */
    const runsOf = (of: readonly PathSegment[]): Promise<string> =>
      runsSource(flightsOf(flightColumns(of)), flatRuns(runs, 4)).text();

    /** Whether `drawn` is `points` drawn as drawHeat draws them */
    async function expectDrawn(
      drawn: ReturnType<typeof drawHeat>,
    ): Promise<void> {
      const expected = drawHeat(heatColumns(points, weights));
      expect(drawn.exposure).toBe(expected.exposure);
      expect(await drawn.source.text()).toBe(await expected.source.text());
    }

    it("asks the worker to draw a heat, packed here and handed over", async () => {
      const decoder = createYearDecoder({ createWorker });
      const postMessage = vi.spyOn(worker, "postMessage");

      await expectDrawn(await decoder.drawHeat(points, weights));

      const [request, transfer] = postMessage.mock.calls[0]!;
      expect(request).toEqual({ id: 0, heat: heatColumns(points, weights) });
      const { heat } = request as { heat: Float64Array };
      expect(transfer).toEqual([heat.buffer]);
      expect(logError).not.toHaveBeenCalled();
    });

    it("hands the worker the flights once, and has it draw the lines along them", async () => {
      const decoder = createYearDecoder({ createWorker });
      const postMessage = vi.spyOn(worker, "postMessage");

      const heat = await decoder.heatLines(segments, null, 2);
      const lines = await decoder.runsSource(segments, runs, 4);

      expect(await heat.text()).toBe(heatLinesOf(segments));
      expect(await lines.text()).toBe(await runsOf(segments));
      const [first, transfer] = postMessage.mock.calls[0]!;
      expect(first).toMatchObject({
        id: 0,
        flights: flightColumns(segments),
        heatLines: { keep: null, exposure: 2 },
      });
      // Handed over: the page draws from the segments if it has to
      expect(transfer).toHaveLength(4);
      // The worker keeps them for the next lines
      expect("flights" in postMessage.mock.calls[1]![0]).toBe(false);
      expect(postMessage.mock.calls[1]![0]).toMatchObject({
        runs: flatRuns(runs, 4),
      });
    });

    it("hands the worker the flights of another array, and a heat's paths", async () => {
      const decoder = createYearDecoder({ createWorker });
      const fewer = segments.slice(0, 2);

      await decoder.heatLines(segments, null, 2);
      await decoder.heatLines(fewer, new Set([1]), 2);
      await decoder.heatLines(segments, null, 2);

      expect(worker.requests.map((request) => "flights" in request)).toEqual([
        true,
        true,
        true,
      ]);
      expect(worker.requests[1]).toMatchObject({
        heatLines: { keep: new Float64Array([1]) },
      });
    });

    it("draws here the lines the worker failed over, and hands it the flights again", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.heatLines(segments, null, 2);

      worker.say({
        id: 0,
        error: "no flights to draw lines along",
        name: "Error",
        format: DATA_FORMAT_VERSION,
      });

      expect(await (await owed).text()).toBe(heatLinesOf(segments));
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not draw the heat lines:",
        "no flights to draw lines along",
      );
      worker.answers = true;
      await decoder.runsSource(segments, runs, 4);
      expect("flights" in worker.requests[1]!).toBe(true);
    });

    it("draws and writes here where there are no workers", async () => {
      vi.stubGlobal("Worker", undefined);
      const decoder = createYearDecoder();

      await expectDrawn(await decoder.drawHeat(points, weights));
      expect(await (await decoder.heatLines(segments, null, 2)).text()).toBe(
        heatLinesOf(segments),
      );
      expect(await (await decoder.runsSource(segments, runs, 4)).text()).toBe(
        await runsOf(segments),
      );
    });

    it("draws here what the worker failed over, and keeps the worker", async () => {
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const owed = decoder.drawHeat(points, weights);
      // Taken as a real worker takes it, which leaves the page's column
      // empty: the heat is packed again to be drawn here
      const { heat } = worker.requests[0] as { heat: Float64Array };
      structuredClone(heat, { transfer: [heat.buffer] });
      expect(heat).toHaveLength(0);

      worker.say({
        id: 0,
        error: "out of memory",
        name: "RangeError",
        format: DATA_FORMAT_VERSION,
      });

      await expectDrawn(await owed);
      expect(logError).toHaveBeenCalledWith(
        "Year worker could not draw the heat:",
        "out of memory",
      );
      expect(worker.terminate).not.toHaveBeenCalled();
    });

    it("draws nothing after the app has ended", async () => {
      const decoder = createYearDecoder({ createWorker });

      decoder.destroy();

      await expect(decoder.drawHeat(points, weights)).rejects.toThrow(
        "year decoder destroyed",
      );
      await expect(decoder.heatLines(segments, null, 1)).rejects.toThrow(
        "year decoder destroyed",
      );
      expect(worker.requests).toEqual([]);
    });
  });

  describe("requests that are given up on", () => {
    it("clears the timer of a year that was answered", async () => {
      vi.useFakeTimers();
      const decoder = createYearDecoder({ createWorker });

      await decoder.decode(yearBytes(year));

      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores an answer nobody waits for", async () => {
      const decoder = createYearDecoder({ createWorker });
      await decoder.decode(yearBytes(year));

      expect(() => worker.answer(worker.requests[0]!)).not.toThrow();
      expect(() =>
        worker.say({
          id: 99,
          error: "stray",
          name: "Error",
          format: DATA_FORMAT_VERSION,
        }),
      ).not.toThrow();
      expect(logError).not.toHaveBeenCalled();
    });

    it("ends the worker and every wait with the app", async () => {
      vi.useFakeTimers();
      worker.answers = false;
      const decoder = createYearDecoder({ createWorker });
      const first = decoder.decode(yearBytes(year));
      const second = decoder.decode(yearBytes(year));

      decoder.destroy();

      await expect(first).rejects.toThrow("year decoder destroyed");
      await expect(second).rejects.toThrow("year decoder destroyed");
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      // Nothing left that holds on to the requests or their bytes
      expect(vi.getTimerCount()).toBe(0);
      // A late error of the worker starts no decoding on the main thread
      worker.emit("error", { message: "late" });
      expect(logError).not.toHaveBeenCalled();
    });

    it("decodes nothing after the app has ended", async () => {
      const decoder = createYearDecoder({ createWorker });

      decoder.destroy();

      await expect(decoder.decode(yearBytes(year))).rejects.toThrow(
        "year decoder destroyed",
      );
      expect(worker.requests).toEqual([]);
    });
  });
});
