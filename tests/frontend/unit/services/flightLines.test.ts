import { describe, it, expect } from "vitest";
import {
  columnBuffers,
  flatRuns,
  flightColumns,
  flightsOf,
  heatLinesSource,
  runsSource,
} from "../../../../flown/frontend/services/flightLines";
import {
  heatLineFeatures,
  heatWeight,
} from "../../../../flown/frontend/calculations/heatLines";
import { heatLineTone } from "../../../../flown/frontend/calculations/heatTone";
import { runLines } from "../../../../flown/frontend/ui/pathRuns";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createSegment } from "../../testHelpers";

/** A position as the lines are written, to 7 decimals (1 cm) */
const lineDegrees = (value: number): number => Math.round(value * 1e7) / 1e7;

/** `value` with every position of its LineStrings written as the lines are */
function rounded<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) =>
      key === "coordinates"
        ? (inner as number[][]).map((position) => position.map(lineDegrees))
        : inner,
    ),
  ) as T;
}

/**
 * Two flights that turn as they go, the first with times, the second
 * without, and a gap in the log of the first
 */
function flights(): PathSegment[] {
  const along = (pathId: number, lat: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      createSegment({
        path_id: pathId,
        altitude_ft: 1000 + i,
        groundspeed_knots: 60 + i,
        ...(pathId === 1 ? { time: i * 4 } : {}),
        coords: [
          [lat + (i % 2) / 200, 8 + i / 100],
          [lat + ((i + 1) % 2) / 200, 8 + (i + 1) / 100],
        ],
      }),
    );
  const first = along(1, 50, 6);
  first[3]!.coords[0] = [50.3, 8.03];
  return [...first, ...along(2, 51, 5)];
}

describe("flightColumns and flightsOf", () => {
  it("carry the segments to the worker as much as the lines read of them", () => {
    const segments = flights();

    const { segments: carried } = flightsOf(flightColumns(segments));

    expect(carried).toEqual(
      segments.map(({ path_id, coords, groundspeed_knots, time }) => ({
        path_id,
        coords,
        groundspeed_knots,
        altitude_ft: NaN,
        ...(time === undefined ? {} : { time }),
      })),
    );
    // A segment starts with the very pair the one before ends with
    expect(carried[1]!.coords[0]).toBe(carried[0]!.coords[1]);
    expect(carried[3]!.coords[0]).not.toBe(carried[2]!.coords[1]);
  });

  it("hand over every column's buffer", () => {
    const columns = flightColumns(flights());

    expect(columnBuffers(columns)).toEqual(
      Object.values(columns).map((column: Float64Array) => column.buffer),
    );
    expect(columnBuffers(columns)).toHaveLength(4);
  });

  it("smooth a flight the worker had once before again only for another dataset's segments", () => {
    const segments = flights();

    const all = flightsOf(flightColumns(segments)).curves;
    const one = flightsOf(flightColumns(segments.slice(6))).curves;

    // The flights of a year are those of all years as well
    expect(one.chains[0]).toBe(all.chains[all.chains.length - 1]);
  });

  it("keep the curves of the flights handed over last only", () => {
    const segments = flights();

    const first = flightsOf(flightColumns(segments.slice(0, 6))).curves;
    // Another dataset without the first flight lets its curves go
    flightsOf(flightColumns(segments.slice(6)));
    const again = flightsOf(flightColumns(segments.slice(0, 6))).curves;

    expect(again.chains[0]).not.toBe(first.chains[0]);
    expect(again.chains[0]).toEqual(first.chains[0]);
  });

  it("keep two chains of a flight apart that start at one point", () => {
    // East from the stand, a gap while parked there, then north
    const leg = (dLat: number, dLon: number) =>
      Array.from({ length: 3 }, (_, i) =>
        createSegment({
          path_id: 7,
          coords: [
            [52 + dLat * i, 13 + dLon * i],
            [52 + dLat * (i + 1), 13 + dLon * (i + 1)],
          ],
        }),
      );
    const segments = [...leg(0, 0.01), ...leg(0.01, 0)];

    const { curves } = flightsOf(flightColumns(segments));

    expect(curves.chains).toHaveLength(2);
    expect(curves.chains[1]).not.toBe(curves.chains[0]);
    // The second goes north, as its segments do
    const north = curves.chains[1]!.points;
    expect(north[north.length - 1]![0]).toBeGreaterThan(52.02);
  });
});

describe("heatLinesSource", () => {
  it("writes the heat lines of the flights a heat keeps, at its exposure", async () => {
    const segments = flights();
    const held = flightsOf(flightColumns(segments));

    const text = await heatLinesSource(held, {
      keep: new Float64Array([1]),
      exposure: 3,
    }).text();

    expect(JSON.parse(text)).toEqual(
      rounded(
        heatLineFeatures(
          segments,
          (pathId) => pathId === 1,
          (segment, next) => heatWeight(segment, next) * 3,
          heatLineTone,
        ),
      ),
    );
  });

  it("keeps every flight for no paths", async () => {
    const segments = flights();
    const held = flightsOf(flightColumns(segments));

    const text = await heatLinesSource(held, {
      keep: null,
      exposure: 1,
    }).text();

    expect(JSON.parse(text)).toEqual(
      rounded(heatLineFeatures(segments, () => true, heatWeight, heatLineTone)),
    );
  });
});

describe("runsSource", () => {
  it("writes the lines of the runs the page draws itself, to 7 decimals", async () => {
    const segments = flights();
    const runs = [
      { start: 0, end: 3, pathId: 1, color: "#123456" },
      { start: 3, end: 6, pathId: 1, color: "rgb(1, 2, 3)" },
      { start: 7, end: 11, pathId: 2, color: '"quoted"' },
    ];

    const text = await runsSource(
      flightsOf(flightColumns(segments)),
      flatRuns(runs, 5),
    ).text();

    expect(JSON.parse(text)).toEqual(
      rounded({
        type: "FeatureCollection",
        features: runLines(segments, runs, 5),
      }),
    );
  });

  it("writes no runs as no features", async () => {
    const held = flightsOf(flightColumns(flights()));

    expect(await runsSource(held, flatRuns([], 1)).text()).toBe(
      '{"type":"FeatureCollection","features":[]}',
    );
  });
});
