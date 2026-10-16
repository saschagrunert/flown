import {
  describe,
  it,
  expect,
  afterEach,
  beforeEach,
  vi,
  type MockInstance,
} from "vitest";
import {
  DATA_FORMAT_VERSION,
  decodeYear,
  decodeYearBytes,
  expandYearData,
} from "../../../../flown/frontend/services/yearDecode";
import { path, rawYear, yearBytes } from "../../yearFixtures";
import type { PathSegments } from "../../yearFixtures";
import type { KMLDataset, RawYearData } from "../../../../flown/frontend/types";

describe("decodeYear", () => {
  it("lays the paths out in flat columns, a point more than rows per path", () => {
    const decoded = decodeYear(
      rawYear(
        2025,
        {
          "7": path(
            [50, 8],
            [
              [50.1, 8.1, 500, 2, 2],
              [50.2, 8.2, 600, 3],
            ],
          ),
          "9": path([51, 9], [[51.1, 9.1, 700, 90]]),
        },
        [{ id: 7 }, { id: 9 }],
        12,
      ),
    );

    expect([...decoded.pathIds]).toEqual([7, 9]);
    expect([...decoded.rowCounts]).toEqual([2, 1]);
    expect([...decoded.lats]).toEqual([50, 50.1, 50.2, 51, 51.1]);
    expect([...decoded.lons]).toEqual([8, 8.1, 8.2, 9, 9.1]);
    expect([...decoded.altitudes]).toEqual([500, 600, 700]);
    expect([...decoded.speeds]).toEqual([2, 3, 90]);
    // A row without a time is NaN
    expect([...decoded.times]).toEqual([2, NaN, NaN]);
    expect(decoded.path_info).toEqual([{ id: 7 }, { id: 9 }]);
    expect(decoded.original_points).toBe(12);
    expect(decoded.warnings).toEqual([]);
  });

  it("reports a broken path instead of logging it, and trims the columns", () => {
    const broken = path(
      [50, 8],
      [
        [50.1, 8.1, 500, 100],
        [50.2, 8.2, 600, 100],
      ],
    );
    (broken.columns[0] as unknown[])[1] = "x";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const decoded = decodeYear(rawYear(2025, { "1": broken }));

    expect(decoded.warnings).toEqual([
      "Path 1: row 1 is not numeric, dropped the rest",
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect([...decoded.rowCounts]).toEqual([1]);
    expect(decoded.lats).toHaveLength(2);
    expect(decoded.altitudes).toHaveLength(1);
    // A trimmed column owns its buffer, which is what gets transferred
    expect(decoded.altitudes.buffer.byteLength).toBe(8);
    warn.mockRestore();
  });
});

describe("decodeYear ground", () => {
  const rows = [
    [50.1, 8.1, 500, 10],
    [50.2, 8.2, 900, 90],
    [50.3, 8.3, 600, 10],
  ];

  it("reads the ground of every row, and NaN for a path without", () => {
    const decoded = decodeYear(
      rawYear(2025, {
        "1": path([50, 8], rows, [480, 1210, 590]),
        "2": path([50, 8], rows),
      }),
    );

    expect([...decoded.grounds]).toEqual([480, 1210, 590, NaN, NaN, NaN]);
  });

  it("drops a ground that does not fit its path, and keeps the path", () => {
    const short = { ...path([50, 8], rows), ground: [48, 73] };
    const broken = { ...path([50, 8], rows), ground: [48, "x", 1] };
    const decoded = decodeYear(
      rawYear(2025, {
        "1": short,
        "2": broken as unknown as PathSegments,
        "3": path([50, 8], rows, [480, 1210, 590]),
      }),
    );

    expect([...decoded.rowCounts]).toEqual([3, 3, 3]);
    expect([...decoded.grounds]).toEqual([
      NaN,
      NaN,
      NaN,
      NaN,
      NaN,
      NaN,
      480,
      1210,
      590,
    ]);
    expect(decoded.warnings).toEqual([]);
  });

  it("hands the ground to the segments that have it", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path([50, 8], rows, [480, 1210, 590]),
        "2": path([50, 8], rows),
      }),
    );

    expect(data.path_segments.map((s) => s.ground_ft)).toEqual([
      480,
      1210,
      590,
      undefined,
      undefined,
      undefined,
    ]);
    expect("ground_ft" in data.path_segments[3]!).toBe(false);
  });
});

describe("decodeYearBytes", () => {
  it("parses the body of a year file and decodes it", () => {
    const raw = rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 500, 100]]) });

    expect(decodeYearBytes(yearBytes(raw))).toEqual(decodeYear(raw));
  });

  it("throws for a body that is not JSON", () => {
    expect(() => decodeYearBytes(yearBytes("<html>").slice(1))).toThrow(
      SyntaxError,
    );
  });

  it("throws for a file of another format", () => {
    const raw = { ...rawYear(2025, {}), format: DATA_FORMAT_VERSION + 1 };

    expect(() => decodeYearBytes(yearBytes(raw))).toThrow(/another release/);
  });
});

describe("expandYearData", () => {
  it("expands segment rows into path segments", () => {
    const raw = rawYear(
      2025,
      {
        "4": path(
          [50, 8],
          [
            [50.1, 8.1, 1000, 90, 0],
            [50.2, 8.2, 1100, 95, 10],
          ],
        ),
        "7": path([51, 9], [[51.1, 9.1, 500, 80]]),
      },
      [
        { id: 4, year: 2025 },
        { id: 7, year: 2025 },
      ],
      42,
    );

    const data = expandYearData(raw);

    expect(data.original_points).toBe(42);
    expect(data.path_info).toBe(raw.path_info);
    expect(data.path_segments).toEqual([
      {
        path_id: 4,
        coords: [
          [50, 8],
          [50.1, 8.1],
        ],
        altitude_ft: 1000,
        groundspeed_knots: 90,
        time: 0,
      },
      {
        path_id: 4,
        coords: [
          [50.1, 8.1],
          [50.2, 8.2],
        ],
        altitude_ft: 1100,
        groundspeed_knots: 95,
        time: 10,
      },
      {
        path_id: 7,
        coords: [
          [51, 9],
          [51.1, 9.1],
        ],
        altitude_ft: 500,
        groundspeed_knots: 80,
      },
    ]);
  });

  it("omits time when the row has four entries", () => {
    const data = expandYearData(
      rawYear(2025, { "1": path([50, 8], [[50.1, 8.1, 1000, 90]]) }),
    );
    expect("time" in data.path_segments[0]!).toBe(false);
  });

  it("orders paths like path_info, whatever their ids", () => {
    // Ids are content hashes; JavaScript would list "2" before the others
    const data = expandYearData(
      rawYear(
        2025,
        {
          "840108108563": path([50, 8], [[50.1, 8.1, 1, 1]]),
          "10": path([50, 8], [[50.1, 8.1, 1, 1]]),
          "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
        },
        [
          { id: 840108108563, year: 2025 },
          { id: 10, year: 2025 },
          { id: 2, year: 2025 },
        ],
      ),
    );
    expect(data.path_segments.map((s) => s.path_id)).toEqual([
      840108108563, 10, 2,
    ]);
  });

  it("skips a listed path without segments, and keeps the next in place", () => {
    const data = expandYearData(
      rawYear(2025, { "30": path([50, 8], [[50.1, 8.1, 1, 1]]) }, [
        { id: 20, year: 2025 },
        { id: 30, year: 2025 },
      ]),
    );
    expect(data.path_segments.map((s) => s.path_id)).toEqual([30]);
    expect(data.path_info).toHaveLength(2);
  });

  it("reads each path at its own place in the arrays, not by id", () => {
    const raw = rawYear(2025, {
      "5": path([50, 8], [[50.1, 8.1, 100, 1]]),
      "6": path([51, 9], [[51.1, 9.1, 200, 2]]),
    });
    // Arrays that end early leave the paths after the end out
    raw.segments.start.pop();
    for (const column of raw.segments.columns) column.pop();

    const data = expandYearData(raw);

    expect(data.path_segments.map((s) => [s.path_id, s.altitude_ft])).toEqual([
      [5, 100],
    ]);
  });

  it("expands a path listed twice once", () => {
    const data = expandYearData(
      rawYear(2025, { "10": path([50, 8], [[50.1, 8.1, 1, 1]]) }, [
        { id: 10, year: 2025 },
        { id: 10, year: 2025 },
      ]),
    );
    expect(data.path_segments).toHaveLength(1);
  });

  it("skips paths without segments and has no holes in the arrays", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path([50, 8], []),
        "2": path([50, 8], [[50.1, 8.1, 1, 1]]),
      }),
    );
    expect(data.path_segments).toHaveLength(1);
    expect(data.path_segments.every(Boolean)).toBe(true);
  });

  it("shares one coordinate array between neighbouring segments", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 1, 1],
            [50.2, 8.2, 1, 1],
          ],
        ),
      }),
    );
    // The end of a segment is the very same array as the next one's start
    expect(data.path_segments[0]!.coords[1]).toBe(
      data.path_segments[1]!.coords[0],
    );
  });

  describe("malformed paths", () => {
    let warn: MockInstance<typeof console.warn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    const good = (): PathSegments => path([51, 9], [[51.1, 9.1, 500, 80]]);

    /** Expand path "1" next to a good path "2" */
    function expandWith(bad: unknown): KMLDataset {
      return expandYearData(
        rawYear(2025, { "1": bad as PathSegments, "2": good() }),
      );
    }

    /** Only the good path made it, and it has no holes or NaN in it */
    function expectOnlyTheGoodPath(data: KMLDataset): void {
      expect(data.path_segments.map((s) => s.path_id)).toEqual([2]);
      expect(data.path_segments.map((s) => s.coords)).toEqual([
        [
          [51, 9],
          [51.1, 9.1],
        ],
      ]);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("Path 1");
    }

    it.each([
      ["no start point", { ...good(), start: [] }],
      ["a start point that is not numeric", { ...good(), start: ["x", 1] }],
      [
        "a missing column",
        { start: [0, 0], columns: [[1], [1], [1], undefined] },
      ],
      ["columns that are not an array", { start: [0, 0], columns: {} }],
      ["no columns at all", { start: [0, 0] }],
    ])("leaves out a path with %s and warns", (_, bad) => {
      expectOnlyTheGoodPath(expandWith(bad));
    });

    it.each([NaN, Infinity, "1", undefined, {}])(
      "cuts a path short at a row holding %s, keeping the rows before it",
      (value) => {
        const raw = path(
          [50, 8],
          [
            [50.1, 8.1, 500, 80, 0],
            [50.2, 8.2, 500, 80, 1],
            [50.3, 8.3, 500, 80, 2],
          ],
        );
        (raw.columns[1] as unknown[])[1] = value;

        const data = expandWith(raw);

        // A difference is lost, so nothing after it has a known position
        expect(data.path_segments.map((s) => s.coords)).toEqual([
          [
            [50, 8],
            [50.1, 8.1],
          ],
          [
            [51, 9],
            [51.1, 9.1],
          ],
        ]);
        // Every slot is filled: the preallocated arrays are trimmed
        expect(data.path_segments.every(Boolean)).toBe(true);
        expect(warn).toHaveBeenCalledOnce();
      },
    );

    it("cuts a path short where a column ends early", () => {
      const data = expandWith({
        start: [0, 0],
        columns: [[1, 2], [1], [1], [1]],
      });

      expect(data.path_segments.map((s) => s.path_id)).toEqual([1, 2]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it.each([2, 3])("checks column %i as well", (column) => {
      const raw = path([50, 8], [[50.1, 8.1, 500, 80]]);
      (raw.columns[column] as unknown[])[0] = "high";

      expectOnlyTheGoodPath(expandWith(raw));
    });

    it("rejects a time that is present but not numeric", () => {
      const raw = path([50, 8], [[50.1, 8.1, 500, 80, 0]]);
      (raw.columns[4] as unknown[])[0] = "soon";

      expectOnlyTheGoodPath(expandWith(raw));
    });

    it("reads a time column that ends early as rows without a time", () => {
      const data = expandWith({
        start: [0, 0],
        columns: [[1], [1], [1], [1], []],
      });

      expect(data.path_segments.map((s) => s.time)).toEqual([
        undefined,
        undefined,
      ]);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("reads a null time as a row without one", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 500, 80, 10],
            [50.2, 8.2, 500, 80],
            [50.3, 8.3, 500, 80, 30],
          ],
        ),
      }),
    );

    expect(data.path_segments.map((s) => s.time)).toEqual([10, undefined, 30]);
    expect("time" in data.path_segments[1]!).toBe(false);
  });

  it("defaults missing path_info and original_points", () => {
    const data = expandYearData({
      format: DATA_FORMAT_VERSION,
      year: 2025,
      segments: {},
    } as RawYearData);
    expect(data.path_info).toEqual([]);
    expect(data.original_points).toBe(0);
    expect(data.path_segments).toEqual([]);
  });

  it("throws for invalid input", () => {
    expect(() => expandYearData(null as unknown as RawYearData)).toThrow();
    expect(() =>
      expandYearData({
        format: DATA_FORMAT_VERSION,
        path_segments: [],
      } as unknown as RawYearData),
    ).toThrow("segments");
  });

  it.each([undefined, 7, 9, "8"])(
    "refuses a year file written in format %s",
    (format) => {
      expect(() =>
        expandYearData({
          format,
          year: 2025,
          segments: {},
        } as unknown as RawYearData),
      ).toThrow("another release");
    },
  );

  it("decodes the scaled differences back to plain values", () => {
    const data = expandYearData(
      rawYear(2025, {
        "1": path(
          [50, 8],
          [
            [50.1, 8.1, 500, 2, 2],
            [50.2, 8.2, 600, 3, 4],
          ],
        ),
      }),
    );

    expect(data.path_segments[0]!.coords).toEqual([
      [50, 8],
      [50.1, 8.1],
    ]);
    expect(data.path_segments[0]!.altitude_ft).toBe(500);
    expect(data.path_segments[0]!.groundspeed_knots).toBe(2);
    expect(data.path_segments[0]!.time).toBe(2);
    expect(data.path_segments[1]!.coords).toEqual([
      [50.1, 8.1],
      [50.2, 8.2],
    ]);
    expect(data.path_segments[1]!.altitude_ft).toBe(600);
    expect(data.path_segments[1]!.groundspeed_knots).toBe(3);
    expect(data.path_segments[1]!.time).toBe(4);
  });

  it("reads the coordinates as second differences", () => {
    // Written by hand rather than by path(): steps of 2, 3, 2 and 0 in the
    // latitude are the changes 2, 1, -1 and -2 of the step
    const data = expandYearData(
      rawYear(2025, {
        "1": {
          start: [5_000_000, 800_000],
          columns: [
            [2, 1, -1, -2],
            [1, 0, 0, -1],
            [25, 0, 0, 0],
            [90, 0, 0, 0],
            [10, 0, 15, 10],
          ],
        },
      }),
    );

    expect(data.path_segments.map((s) => s.coords[1])).toEqual([
      [50.00002, 8.00001],
      [50.00005, 8.00002],
      [50.00007, 8.00003],
      [50.00007, 8.00003],
    ]);
    // The time stays a first difference, in tenths of a second
    expect(data.path_segments.map((s) => s.time)).toEqual([1, 1, 2.5, 3.5]);
  });
});
