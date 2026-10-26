/**
 * The field at each end of a flight, as fieldFt reads it from the taxiing:
 * the cases of tests/fixtures/field-ground.json, which the build's
 * _field_offset_ft (flown/terrain.py) runs as well, so that the ground the
 * build samples and the one the page draws without it start from the same
 * fields.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { fieldFt } from "../../../../flown/frontend/calculations/groundProfile";
import type { PathSegment } from "../../../../flown/frontend/types";

interface FieldCase {
  name: string;
  rows: [number, number, boolean][];
  start: number | null;
  end: number | null;
}

// vitest runs with the repository root as working directory
const { cases } = JSON.parse(
  readFileSync(join(cwd(), "tests", "fixtures", "field-ground.json"), "utf8"),
) as { cases: FieldCase[] };

describe("fieldFt", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const segments: PathSegment[] = c.rows.map(
      ([altitude, speed, timed], i) => ({
        path_id: 0,
        coords: [
          [50, 8],
          [50, 8],
        ],
        altitude_ft: altitude,
        groundspeed_knots: speed,
        time: timed ? i : undefined,
      }),
    );
    const indices = segments.map((_, i) => i);

    expect(fieldFt(segments, indices)).toBe(c.start);
    expect(fieldFt(segments, [...indices].reverse())).toBe(c.end);
  });
});
