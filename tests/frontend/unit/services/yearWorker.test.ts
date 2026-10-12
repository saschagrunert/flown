import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createYearDecoder,
  handleRequest,
  serveRequests,
  type YearRequest,
  type YearResponse,
  type YearWorkerScope,
} from "../../../../flown/frontend/services/yearWorker";
import {
  DATA_FORMAT_VERSION,
  decodeYear,
} from "../../../../flown/frontend/services/yearDecode";
import { drawHeat } from "../../../../flown/frontend/services/heatSource";
import {
  flatRuns,
  flightColumns,
  flightsOf,
  heatLinesSource,
  runsSource,
} from "../../../../flown/frontend/services/flightLines";
import { heatColumns } from "../../../../flown/frontend/calculations/heatExposure";
import { createSegment } from "../../testHelpers";
import { path, rawYear, yearBytes } from "../../yearFixtures";

const year = rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 500, 100]]) });

describe("handleRequest", () => {
  it("answers with the decoded year under the id of the request", () => {
    const { response } = handleRequest({ id: 7, bytes: yearBytes(year) });

    expect(response).toEqual({ id: 7, decoded: decodeYear(year) });
  });

  it("hands the buffers of the columns over instead of copying them", () => {
    const { response, transfer } = handleRequest({
      id: 1,
      bytes: yearBytes(year),
    });

    if (!("decoded" in response)) throw new Error("not decoded");
    const { lats } = response.decoded;
    expect(transfer).toHaveLength(8);
    expect(transfer).toContain(lats.buffer);
    // The transfer a real worker would make: the columns arrive whole, and
    // are gone on the side that sent them
    const arrived = structuredClone(response, { transfer });
    expect([...arrived.decoded.lats]).toEqual([50, 50.1]);
    expect([...arrived.decoded.altitudes]).toEqual([500]);
    expect(lats.buffer.byteLength).toBe(0);
  });

  it("answers a file it cannot decode with the reason, and does not throw", () => {
    const { response, transfer } = handleRequest({
      id: 3,
      bytes: yearBytes({ format: -1 }),
    });

    // By its name too, which the page tells a file of another release by
    expect(response).toEqual({
      id: 3,
      error: expect.stringContaining("another release") as string,
      name: "StaleDataError",
      // And the format it reads, which the page tells another deploy by
      format: DATA_FORMAT_VERSION,
    });
    expect(transfer).toEqual([]);
  });

  it("answers a body that is not JSON the same way", () => {
    const { response } = handleRequest({
      id: 4,
      bytes: new Uint8Array([60, 104]).buffer,
    });

    expect(response).toMatchObject({ id: 4 });
    expect("error" in response && typeof response.error).toBe("string");
  });

  it("puts what is thrown into words even when it is no Error", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "odd";
    });

    const { response } = handleRequest({ id: 5, bytes: yearBytes(year) });

    parse.mockRestore();
    expect(response).toEqual({
      id: 5,
      error: "odd",
      name: "Error",
      format: DATA_FORMAT_VERSION,
    });
  });
});

describe("handleRequest for the heat sources", () => {
  const heat = heatColumns(
    [
      [50, 8],
      [50.01, 8.01],
    ],
    [1, 2],
  );

  it("draws a heat, a Blob and nothing to hand over", async () => {
    const { response, transfer } = handleRequest({ id: 3, heat });

    if (!("drawn" in response)) throw new Error("not drawn");
    const expected = drawHeat(heat);
    expect(response.id).toBe(3);
    expect(response.drawn.exposure).toBe(expected.exposure);
    expect(await response.drawn.source.text()).toBe(
      await expected.source.text(),
    );
    expect(transfer).toEqual([]);
  });

  describe("lines along the flights", () => {
    const segments = [0, 1, 2].map((i) =>
      createSegment({
        path_id: 1 + Math.floor(i / 2),
        time: i * 4,
        coords: [
          [50 + i / 100, 8 + i / 100],
          [50 + (i + 1) / 100, 8 + (i + 1) / 100],
        ],
      }),
    );
    const flights = flightsOf(flightColumns(segments));
    const heatLines = { keep: new Float64Array([2]), exposure: 2 };
    const runs = flatRuns(
      [{ start: 0, end: 2, pathId: 1, color: "#123456" }],
      3,
    );

    /** The text of the source of the answer to `request` */
    async function written(request: YearRequest): Promise<string> {
      const { response, transfer } = handleRequest(request);
      if (!("source" in response)) throw new Error("not written");
      expect(transfer).toEqual([]);
      return response.source.text();
    }

    it("writes the heat lines and the runs along the flights handed over", async () => {
      expect(
        await written({
          id: 4,
          flights: flightColumns(segments),
          heatLines,
        }),
      ).toBe(await heatLinesSource(flights, heatLines).text());
      // Along the flights handed over last, which the worker keeps
      expect(await written({ id: 5, runs })).toBe(
        await runsSource(flights, runs).text(),
      );
    });

    it("keeps no flights of before when the new ones fail to arrive", async () => {
      await written({ id: 7, flights: flightColumns(segments), heatLines });
      const broken = {
        ...flightColumns(segments),
        coords: null as unknown as Float64Array,
      };

      expect(
        "error" in handleRequest({ id: 8, flights: broken, runs }).response,
      ).toBe(true);
      // Asked for without flights, as the page does for the same ones: not
      // along those of before, so the page draws them and hands them again
      expect(handleRequest({ id: 9, runs }).response).toEqual(
        expect.objectContaining({
          id: 9,
          error: "no flights to draw lines along",
        }),
      );
    });

    it("answers lines asked for before any flights with the reason", async () => {
      vi.resetModules();
      const fresh =
        await import("../../../../flown/frontend/services/yearWorker");

      expect(fresh.handleRequest({ id: 6, runs }).response).toEqual({
        id: 6,
        error: "no flights to draw lines along",
        name: "Error",
        format: DATA_FORMAT_VERSION,
      });
    });
  });

  it("answers a heat it fails over with the reason", () => {
    const { response } = handleRequest({
      id: 5,
      heat: undefined as unknown as Float64Array,
    });

    expect(response).toEqual({
      id: 5,
      error: expect.any(String) as string,
      name: "TypeError",
      format: DATA_FORMAT_VERSION,
    });
  });
});

describe("serveRequests", () => {
  it("answers every message of the scope, transfer list included", () => {
    const scope: YearWorkerScope = { onmessage: null, postMessage: vi.fn() };

    serveRequests(scope);
    scope.onmessage!({
      data: { id: 2, bytes: yearBytes(year) },
    } as MessageEvent<YearRequest>);

    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    const [response, transfer] = vi.mocked(scope.postMessage).mock.calls[0]!;
    expect(response).toEqual({ id: 2, decoded: decodeYear(year) });
    expect(transfer).toHaveLength(8);
  });
});

describe("the module", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("installs no message handler in a page that imports it", () => {
    // Imported above, in a window: the page's own onmessage is untouched
    expect(globalThis.onmessage).toBeNull();
  });

  it("serves requests when it runs as a worker", async () => {
    const postMessage = vi.fn<(response: YearResponse) => void>();
    vi.stubGlobal("WorkerGlobalScope", class {});
    vi.stubGlobal("postMessage", postMessage);
    vi.stubGlobal("onmessage", null);
    vi.resetModules();

    await import("../../../../flown/frontend/services/yearWorker");
    (globalThis as unknown as YearWorkerScope).onmessage!({
      data: { id: 9, bytes: yearBytes(year) },
    } as MessageEvent<YearRequest>);

    expect(postMessage.mock.calls[0]![0]).toMatchObject({ id: 9 });
  });

  it("exports what the page starts the worker with", () => {
    expect(createYearDecoder).toBeTypeOf("function");
  });
});
