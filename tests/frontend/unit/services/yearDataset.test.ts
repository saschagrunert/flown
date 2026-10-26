import { describe, it, expect, vi } from "vitest";
import {
  buildDataset,
  buildDatasetInSlices,
  combineYearData,
  transferablesOf,
} from "../../../../flown/frontend/services/yearDataset";
import { decodeYear } from "../../../../flown/frontend/services/yearDecode";
import { dataset, path, rawYear } from "../../yearFixtures";
import type { PathSegments } from "../../yearFixtures";
import type { RawYearData } from "../../../../flown/frontend/types";

/** A year of `paths` paths with `rows` rows each */
function longYear(paths: number, rows: number): RawYearData {
  const segments: Record<string, PathSegments> = {};
  for (let id = 1; id <= paths; id++) {
    segments[String(id)] = path(
      [50, 8],
      Array.from({ length: rows }, (_, row) => [
        50 + (row + 1) / 1000,
        8 + (row + 1) / 1000,
        1000 + 100 * (row % 3),
        100,
        row,
      ]),
    );
  }
  return rawYear(
    2025,
    segments,
    Object.keys(segments).map((id) => ({ id: Number(id) })),
  );
}

describe("transferablesOf", () => {
  it("names the buffer of every column, and nothing twice", () => {
    const decoded = decodeYear(longYear(2, 3));

    const buffers = transferablesOf(decoded);

    expect(buffers).toHaveLength(8);
    expect(new Set(buffers).size).toBe(8);
    expect(buffers).toContain(decoded.lats.buffer);
    expect(buffers).toContain(decoded.rowCounts.buffer);
    // What a transfer requires
    expect(buffers.every((buffer) => buffer instanceof ArrayBuffer)).toBe(true);
  });
});

describe("buildDataset", () => {
  it("shares the coordinate between neighbouring segments", () => {
    const data = buildDataset(decodeYear(longYear(1, 3)));

    expect(data.path_segments).toHaveLength(3);
    expect(data.path_segments[1]!.coords[0]).toBe(
      data.path_segments[0]!.coords[1],
    );
  });

  it("leaves the time out of a segment whose row has none", () => {
    const data = buildDataset(
      decodeYear(
        rawYear(2025, {
          "1": path(
            [50, 8],
            [
              [50.1, 8.1, 500, 100, 0],
              [50.2, 8.2, 500, 100],
            ],
          ),
        }),
      ),
    );

    expect(data.path_segments[0]!.time).toBe(0);
    expect("time" in data.path_segments[1]!).toBe(false);
  });
});

describe("buildDatasetInSlices", () => {
  it("builds the same dataset as in one go", async () => {
    // Long enough for a path to span several looks at the clock
    const decoded = decodeYear(longYear(3, 2500));

    await expect(buildDatasetInSlices(decoded)).resolves.toEqual(
      buildDataset(decoded),
    );
  });

  it("gives the main thread back whenever a slice is over, also within a path", async () => {
    const decoded = decodeYear(longYear(2, 2500));
    // Every look at the clock finds the slice over
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10));
    const pause = vi.fn(() => Promise.resolve());

    const data = await buildDatasetInSlices(decoded, pause);

    // 2500 rows are three looks per path; the last one ends the build
    expect(pause).toHaveBeenCalledTimes(5);
    expect(data).toEqual(buildDataset(decoded));
  });

  it("does not pause for a year that fits into one slice", async () => {
    const pause = vi.fn(() => Promise.resolve());

    const data = await buildDatasetInSlices(decodeYear(longYear(2, 3)), pause);

    expect(pause).not.toHaveBeenCalled();
    expect(data.path_segments).toHaveLength(6);
  });

  it("pauses with a task of its own by default", async () => {
    const decoded = decodeYear(longYear(1, 1500));
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10));

    await expect(buildDatasetInSlices(decoded)).resolves.toEqual(
      buildDataset(decoded),
    );
  });

  it("builds an empty dataset for a year without paths", async () => {
    await expect(
      buildDatasetInSlices(decodeYear(rawYear(2025, {}))),
    ).resolves.toEqual({ path_segments: [], path_info: [] });
  });
});

describe("combineYearData", () => {
  it("concatenates datasets without remapping or copying objects", () => {
    const a = dataset(2, 1);
    const b = dataset(1, 3);

    const result = combineYearData([a, b]);

    expect(result.path_segments).toHaveLength(3);
    expect(result.path_info).toHaveLength(3);
    expect(result.path_segments.map((s) => s.path_id)).toEqual([1, 2, 3]);
    // Same object references (no copies)
    expect(result.path_segments[0]).toBe(a.path_segments[0]);
    expect(result.path_segments[2]).toBe(b.path_segments[0]);
    expect(result.path_info[2]).toBe(b.path_info[0]);
  });

  it("gives arrays of its own, for one year as well", () => {
    const a = dataset(2, 1);

    const result = combineYearData([a]);

    expect(result.path_segments).not.toBe(a.path_segments);
    expect(result.path_segments).toEqual(a.path_segments);
    expect(result.path_info).not.toBe(a.path_info);
  });

  it("skips null or undefined datasets", () => {
    const result = combineYearData([dataset(1), null, undefined]);
    expect(result.path_segments).toHaveLength(1);
  });

  it("returns an empty dataset for no input", () => {
    expect(combineYearData([])).toEqual({ path_segments: [], path_info: [] });
  });
});
