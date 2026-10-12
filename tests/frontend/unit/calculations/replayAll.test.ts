/**
 * The points of the replay of all flights: every flight's curve with the
 * seconds into its flight at each point, thinned for the zoom it is drawn
 * at, the step from one curve to the next left out; and the camera that
 * fits them on a tilted map.
 */
import { describe, it, expect, vi } from "vitest";
import {
  fitTilted,
  fixPoints,
  LEG_PAUSE_S,
  REPLAY_ALL_POINT_FLOATS,
  replayAllPoints,
  sequenceStarts,
  worldShifts,
  type FitMap,
  type ReplayAllPoints,
} from "../../../../flown/frontend/calculations/replayAll";
import { mercatorOf } from "../../../../flown/frontend/utils/mercator";
import * as clockModule from "../../../../flown/frontend/calculations/flightClock";
import { flightClock } from "../../../../flown/frontend/calculations/flightClock";
import { heatWeight } from "../../../../flown/frontend/calculations/heatLines";
import { smoothFlights } from "../../../../flown/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../flown/frontend/types";

/**
 * A flight of `path_id`: `count` fixes a thousandth of a degree apart
 * along the latitude `lat`, 5 s apart, or untimed at `knots`
 */
function flight(
  path_id: number,
  lat: number,
  { count = 41, timed = true, knots = 100, altitude = 3000 } = {},
): PathSegment[] {
  return Array.from({ length: count - 1 }, (_, i) => ({
    path_id,
    coords: [
      [lat, 11 + i * 0.001],
      [lat, 11 + (i + 1) * 0.001],
    ],
    altitude_ft: altitude,
    groundspeed_knots: knots,
    ...(timed ? { time: i * 5 } : {}),
  }));
}

function build(
  segments: PathSegment[],
  {
    keep = () => true,
    detail = 12,
    level = 6,
    starts,
    colourOf,
  }: {
    keep?: (pathId: number) => boolean;
    detail?: number;
    level?: number;
    starts?: ReadonlyMap<number, number>;
    colourOf?: (segment: PathSegment) => number;
  } = {},
): ReplayAllPoints {
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 1000,
  });
  return replayAllPoints(
    segments,
    flights,
    flightClock(segments),
    keep,
    detail,
    level,
    starts,
    colourOf,
  );
}

/** Field `f` of every point */
function column(points: ReplayAllPoints, f: number): number[] {
  const values: number[] = [];
  for (let k = 0; k < points.count; k++) {
    values.push(points.points[k * REPLAY_ALL_POINT_FLOATS + f]!);
  }
  return values;
}

describe("replayAllPoints", () => {
  it("weighs the curves as the heat cloud does, so both keep one weighing", () => {
    const pieces = vi.spyOn(clockModule, "chainPieces");
    try {
      build([...flight(1, 47), ...flight(2, 48)]);
      expect(pieces).toHaveBeenCalledTimes(2);
      for (const call of pieces.mock.calls) expect(call[5]).toBe(heatWeight);
    } finally {
      pieces.mockRestore();
    }
  });

  it("gives every point the seconds into its flight, from 0", () => {
    const points = build(flight(1, 47));
    const times = column(points, 4);

    expect(times[0]).toBe(0);
    for (let k = 1; k < times.length; k++) {
      expect(times[k]!).toBeGreaterThan(times[k - 1]!);
    }
    // The last fix is at 195 s, and its segment takes its length at 100 kt
    expect(times[times.length - 1]).toBeCloseTo(points.duration, 3);
    expect(points.duration).toBeGreaterThan(195);
  });

  it("starts every flight at 0 and joins no curve to the next", () => {
    const points = build([...flight(1, 47), ...flight(2, 48)]);
    const times = column(points, 4);
    const joins = column(points, 5);

    expect(points.flights).toBe(2);
    const second = times.indexOf(0, 1);
    expect(second).toBeGreaterThan(0);
    // The last point of the first curve leads nowhere, every other one on
    expect(joins[second - 1]).toBe(0);
    expect(joins[joins.length - 1]).toBe(0);
    expect(joins.filter((join) => join === 0)).toHaveLength(2);
  });

  it("colours each point as the segment the stretch up to it lies along, and none without colours", () => {
    // A climb of 100 ft a segment, the colour of each its altitude
    const segments = flight(1, 47).map((segment, i) => ({
      ...segment,
      altitude_ft: 1000 + 100 * i,
    }));
    const points = build(segments, { colourOf: (s) => s.altitude_ft });
    const times = column(points, 4);
    const colours = column(points, 6);

    // The first point is the first segment's, and each after it the one
    // of the segment its time falls in: segment i is flown from 5 i s on
    expect(colours[0]).toBe(1000);
    for (let k = 1; k < colours.length; k++) {
      const segment = Math.min(Math.ceil(times[k]! / 5 - 1e-6) - 1, 39);
      expect(colours[k]).toBe(1000 + 100 * segment);
    }
    expect(colours[colours.length - 1]).toBe(1000 + 100 * 39);
    expect(column(build(segments), 6).every((colour) => colour === 0)).toBe(
      true,
    );
  });

  it("thins the curves for the zoom, more closely the closer in", () => {
    const segments = flight(1, 47, { count: 401 });

    const far = build(segments, { detail: 8 });
    const near = build(segments, { detail: 14 });

    // 0.4 degrees of longitude, 30 km: at zoom 8.5 some 200 pixels, about
    // 50 points 4 pixels apart; at 14.5 every fix, 76 m apart
    expect(far.count).toBeLessThan(60);
    expect(far.count).toBeGreaterThan(40);
    expect(near.count).toBe(401);
    // Either end of the curve is kept
    expect(column(far, 4)[0]).toBe(0);
    expect(column(far, 4)[far.count - 1]).toBeCloseTo(far.duration, 3);
  });

  it("keeps a point where the height changes, the more the more it is exaggerated", () => {
    // Climbing 100 ft a fix
    const segments = flight(1, 47, { count: 101 }).map((segment, i) => ({
      ...segment,
      altitude_ft: 1000 + i * 100,
    }));
    const level = (at: number): number =>
      build(segments, { detail: 6, level: at }).count;

    // Ten times its height out to level 7, twice from level 10 in
    expect(level(6)).toBeGreaterThan(level(10));
    // A level flight keeps the points of its length alone, at every level
    const cruise = flight(1, 47, { count: 101 });
    const cruising = build(cruise, { detail: 6, level: 6 }).count;
    expect(build(cruise, { detail: 6, level: 10 }).count).toBe(cruising);
    expect(level(10)).toBeGreaterThan(cruising);
  });

  it("plays only the flights it is asked to", () => {
    const segments = [...flight(1, 47), ...flight(2, 48), ...flight(3, 49)];

    const points = build(segments, { keep: (id) => id !== 2 });

    expect(points.flights).toBe(2);
    const [west, south, east, north] = points.bounds!;
    expect(south).toBe(47);
    expect(north).toBe(49);
    expect(west).toBe(11);
    expect(east).toBeCloseTo(11.04, 6);
  });

  it("clocks an untimed flight by its speed, and leaves out one without either", () => {
    const segments = [
      ...flight(1, 47, { timed: false, knots: 50 }),
      ...flight(2, 48, { timed: false, knots: 0 }),
    ];

    const points = build(segments);

    expect(points.flights).toBe(1);
    // Twice as long as at 100 kt
    const fast = build(flight(1, 47, { timed: false, knots: 100 }));
    expect(points.duration).toBeCloseTo(2 * fast.duration, 3);
  });

  it("gives its points from an origin near them", () => {
    const points = build(flight(1, 47));

    const xs = column(points, 0);
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-4);
    expect(points.origin[0]).toBeCloseTo((11.02 + 180) / 360, 6);
  });

  it("takes a flight across the antimeridian the short way", () => {
    const segments = Array.from({ length: 20 }, (_, i) => {
      const lng = (k: number): number => {
        const east = 179.95 + k * 0.005;
        return east > 180 ? east - 360 : east;
      };
      return {
        path_id: 1,
        coords: [
          [10, lng(i)],
          [10, lng(i + 1)],
        ] as [[number, number], [number, number]],
        altitude_ft: 3000,
        groundspeed_knots: 100,
        time: i * 5,
      };
    });
    for (const detail of [4, 12, 16]) {
      const points = build(segments, { detail });
      const xs = column(points, 0);
      expect(xs.length).toBeGreaterThan(1);
      const steps = xs.slice(1).map((x, k) => Math.abs(x - xs[k]!));
      expect(Math.max(...steps)).toBeLessThan(0.2 / 360);
      // On past 180 rather than back round the world
      expect(points.bounds![0]).toBeCloseTo(179.95, 6);
      expect(points.bounds![2]).toBeCloseTo(180.05, 6);
    }
  });

  it("lays flights either side of the antimeridian in one world, their bounds narrow", () => {
    // One flight from 179.5 E on past 180, written down from 179.5 W on,
    // and one wholly west of 180, at 179.4 W
    const at = (path_id: number, from: number): PathSegment[] =>
      flight(path_id, 10, { count: 11 }).map((segment) => ({
        ...segment,
        coords: segment.coords.map(([lat, lng]) => {
          const east = from + (lng - 11);
          return [lat, east > 180 ? east - 360 : east];
        }) as PathSegment["coords"],
      }));
    const points = build([...at(1, 179.995), ...at(2, -179.4)]);
    const [west, , east] = points.bounds!;
    expect(west).toBeCloseTo(179.995, 6);
    expect(east).toBeCloseTo(180.61, 6);
    expect(points.xs[1] - points.xs[0]).toBeLessThan(1 / 360);
    // The second flight drawn a world east of where it is written down
    const xs = column(points, 0).map((x) => x + points.origin[0]);
    expect(Math.min(...xs)).toBeGreaterThan(0.99);
    expect(Math.max(...xs)).toBeLessThan(1.01);
  });

  it("keeps flights either side of the antimeridian together beside a far-off first flight", () => {
    const at = (path_id: number, from: number): PathSegment[] =>
      flight(path_id, 10, { count: 11 }).map((segment) => ({
        ...segment,
        coords: segment.coords.map(([lat, lng]) => {
          const east = from + (lng - 11);
          return [lat, east > 180 ? east - 360 : east];
        }) as PathSegment["coords"],
      }));
    // A flight in England first, then Fiji on past 180 and Samoa at 172 W
    const points = build([...at(1, -1), ...at(2, 179.995), ...at(3, -172)]);
    const [west, , east] = points.bounds!;
    // Not round the whole world: Fiji and Samoa side by side east of 180,
    // England a world on
    expect(west).toBeCloseTo(179.995, 6);
    expect(east - west).toBeLessThan(200);
    const xs = column(points, 0).map((x) => x + points.origin[0]);
    const pacific = xs.slice(points.count / 3);
    expect(Math.min(...pacific)).toBeGreaterThan(0.99);
    expect(Math.max(...pacific)).toBeLessThan(1.03);
  });

  it("has nothing to play without flights", () => {
    const points = build([]);

    expect(points.count).toBe(0);
    expect(points.flights).toBe(0);
    expect(points.duration).toBe(0);
    expect(points.bounds).toBeNull();
  });

  it("plays flights one after another from where `starts` puts them", () => {
    const segments = [...flight(1, 47), ...flight(2, 48)];
    const clock = flightClock(segments);
    const first = clock.duration.get(1)!;
    const second = clock.duration.get(2)!;
    // The second flight first, as the order of the files may have it
    const starts = sequenceStarts([2, 1], clock.duration);
    const points = build(segments, {
      starts,
      keep: (pathId) => starts.has(pathId),
    });
    const times = column(points, 4);
    const once = build(segments);
    const alone = column(once, 4);

    expect(points.flights).toBe(2);
    // Flight 1's curve comes first in the dataset, and starts after the
    // whole of flight 2 and the pause
    const offset = second + LEG_PAUSE_S;
    expect(times[0]).toBeCloseTo(offset, 3);
    const split = alone.indexOf(0, 1);
    expect(split).toBeGreaterThan(0);
    for (let k = 0; k < split; k++) {
      expect(times[k]).toBeCloseTo(alone[k]! + offset, 2);
    }
    // Flight 2 plays from 0, as it would alone
    expect(times.slice(split)).toEqual(alone.slice(split));
    // The run ends as the last of them lands
    expect(points.duration).toBeCloseTo(offset + first, 6);
  });
});

describe("sequenceStarts", () => {
  it("starts each flight where the one before has landed, after a pause", () => {
    const duration = new Map([
      [5, 3600],
      [3, 1800],
      [9, 2400],
    ]);

    expect([...sequenceStarts([3, 9, 5], duration)]).toEqual([
      [3, 0],
      [9, 1800 + LEG_PAUSE_S],
      [5, 1800 + 2400 + 2 * LEG_PAUSE_S],
    ]);
  });

  it("leaves out a flight without a clock, and one given twice", () => {
    const duration = new Map([
      [1, 600],
      [2, 0],
      [3, 900],
    ]);

    expect([...sequenceStarts([1, 2, 4, 1, 3], duration)]).toEqual([
      [1, 0],
      [3, 600 + LEG_PAUSE_S],
    ]);
    expect(sequenceStarts([], duration).size).toBe(0);
  });
});

describe("fixPoints", () => {
  it("puts both ends of every segment where they are, as a run's points", () => {
    const segments = flight(1, 47);
    const fixes = fixPoints(segments);

    expect(fixes.count).toBe(2 * segments.length);
    expect(fixes.points).toHaveLength(fixes.count * REPLAY_ALL_POINT_FLOATS);
    segments.forEach(({ coords }, i) => {
      coords.forEach((fix, end) => {
        const k = (2 * i + end) * REPLAY_ALL_POINT_FLOATS;
        const [x, y] = mercatorOf(fix);
        expect(fixes.points[k]! + fixes.origin[0]).toBeCloseTo(x, 9);
        expect(fixes.points[k + 1]! + fixes.origin[1]).toBeCloseTo(y, 9);
      });
    });
    expect(fixPoints([]).count).toBe(0);
  });

  it("keeps a flight across the antimeridian on one copy of the world", () => {
    // From Fiji, east across 180 degrees
    const segments: PathSegment[] = [178.5, 179.5, -179.5].map((lng, i) => ({
      path_id: 1,
      coords: [
        [-17.5, lng],
        [-17.5, i === 2 ? -178.5 : lng + 1],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 100,
    }));
    const { points, count } = fixPoints(segments);

    const xs = Array.from(
      { length: count },
      (_, n) => points[n * REPLAY_ALL_POINT_FLOATS]!,
    );
    // Three degrees east of the first fix at most, never a world west
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(3 / 360, 6);
  });
});

describe("the fit of the flights on a tilted map", () => {
  /** A desktop map, the panel of the replay along its bottom */
  const MAP: FitMap = {
    width: 1440,
    height: 900,
    padding: { top: 24, right: 24, bottom: 110, left: 24 },
    pitch: 50,
    fov: 36.87,
  };
  /** Flights from the Baltic to the Adriatic, wider in the south */
  const RUN = build([
    ...flight(1, 54.5, { count: 3 }),
    ...flight(2, 45.5, { count: 3 }),
  ]);
  // Spread out east and west, a flight at each end
  const spread: [number, number][] = [
    [8, 54.5],
    [14, 54],
    [5.5, 47],
    [16.5, 45.5],
  ];
  const run = {
    ...RUN,
    points: Float32Array.from(
      spread.flatMap(([lng, lat]) => {
        const [x, y] = mercatorOf([lat, lng]);
        return [x - RUN.origin[0], y - RUN.origin[1], 0, 0, 0, 1, 0];
      }),
    ),
    count: spread.length,
  };

  /**
   * Where MapLibre draws `[lng, lat]` on the flat map of `map` with the
   * camera `camera`, worked out anew: the map turned by its bearing (east
   * up at 90), the camera at the distance of the field of view from the
   * middle of the map, turned down by the tilt, and a perspective division
   * by the depth along its view
   */
  function project(
    [lng, lat]: [number, number],
    camera: { center: [number, number]; zoom: number },
    map: FitMap = MAP,
  ): [number, number] {
    const world = 512 * 2 ** camera.zoom;
    const [cx, cy] = mercatorOf([camera.center[1], camera.center[0]]);
    const [x, y] = mercatorOf([lat, lng]);
    const pitch = (map.pitch * Math.PI) / 180;
    const distance = map.height / 2 / Math.tan((map.fov * Math.PI) / 360);
    // The camera, south of the middle and above it, looking at it
    const eye = [0, distance * Math.sin(pitch), distance * Math.cos(pitch)];
    const ahead = eye.map((v) => -v / distance);
    const up = [0, -Math.cos(pitch), Math.sin(pitch)];
    const turn = ((map.bearing ?? 0) * Math.PI) / 180;
    const east = (x - cx) * world;
    const south = (y - cy) * world;
    const to = [
      east * Math.cos(turn) + south * Math.sin(turn),
      south * Math.cos(turn) - east * Math.sin(turn),
      0,
    ].map((v, i) => v - eye[i]!);
    const dot = (a: number[], b: number[]) =>
      a.reduce((sum, v, i) => sum + v * b[i]!, 0);
    const depth = dot(to, ahead);
    return [
      map.width / 2 + (to[0]! * distance) / depth,
      map.height / 2 - (dot(to, up) * distance) / depth,
    ];
  }

  /** Left, top, right and bottom of the flights with `camera` */
  function box(
    camera: { center: [number, number]; zoom: number },
    map: FitMap = MAP,
  ): [number, number, number, number] {
    const at = spread.map((place) => project(place, camera, map));
    const xs = at.map(([x]) => x);
    const ys = at.map(([, y]) => y);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  it("fills the room between the padding with the flights, all of them in it", () => {
    const camera = fitTilted(run, { center: [11, 50], zoom: 5 }, MAP, 22);

    const [left, top, right, bottom] = box(camera);
    const { padding } = MAP;
    expect(left).toBeGreaterThanOrEqual(padding.left - 2);
    expect(right).toBeLessThanOrEqual(MAP.width - padding.right + 2);
    expect(top).toBeGreaterThanOrEqual(padding.top - 2);
    expect(bottom).toBeLessThanOrEqual(MAP.height - padding.bottom + 2);
    // Across or down, edge to edge of the room
    const fill = Math.max(
      (right - left) / (MAP.width - padding.left - padding.right),
      (bottom - top) / (MAP.height - padding.top - padding.bottom),
    );
    expect(fill).toBeGreaterThan(0.98);
    // Tilted, the north is further away and smaller than the south
    const north = project([14, 54], camera)[0] - project([8, 54], camera)[0];
    const south = project([14, 46], camera)[0] - project([8, 46], camera)[0];
    expect(north).toBeLessThan(south);
  });

  it("fills the room of a turned map as well", () => {
    for (const bearing of [90, -35, 180]) {
      const turned = { ...MAP, bearing };

      const camera = fitTilted(run, { center: [11, 50], zoom: 5 }, turned, 22);

      const [left, top, right, bottom] = box(camera, turned);
      const { padding } = MAP;
      expect(left).toBeGreaterThanOrEqual(padding.left - 2);
      expect(right).toBeLessThanOrEqual(MAP.width - padding.right + 2);
      expect(top).toBeGreaterThanOrEqual(padding.top - 2);
      expect(bottom).toBeLessThanOrEqual(MAP.height - padding.bottom + 2);
      const fill = Math.max(
        (right - left) / (MAP.width - padding.left - padding.right),
        (bottom - top) / (MAP.height - padding.top - padding.bottom),
      );
      expect(fill).toBeGreaterThan(0.98);
    }
    // Taller than wide, the flights lie along the wide flat map with east
    // up, which comes closer in than north up
    const flat = { ...MAP, pitch: 0 };
    const north = fitTilted(run, { center: [11, 50], zoom: 5 }, flat, 22);
    const east = fitTilted(
      run,
      { center: [11, 50], zoom: 5 },
      { ...flat, bearing: 90 },
      22,
    );
    expect(east.zoom).toBeGreaterThan(north.zoom + 0.2);
  });

  it("fits a flat map as a fit of the bounds does", () => {
    const flat = { ...MAP, pitch: 0 };

    const camera = fitTilted(run, { center: [11, 50], zoom: 5 }, flat, 22);

    const [left, top, right, bottom] = box(camera, flat);
    // Down fills the room: the flights are taller than wide for it
    expect(top).toBeCloseTo(24, 0);
    expect(bottom).toBeCloseTo(900 - 110, 0);
    expect((left + right) / 2).toBeCloseTo(720, 0);
  });

  it("comes in from behind the camera of a steep tilt", () => {
    const steep = { ...MAP, pitch: 85 };

    const camera = fitTilted(run, { center: [11, 50], zoom: 9 }, steep, 22);

    expect(camera.zoom).toBeLessThan(9);
    const [left, top, right, bottom] = box(camera, steep);
    expect([left, top, right, bottom].every(Number.isFinite)).toBe(true);
    expect(top).toBeGreaterThanOrEqual(24 - 2);
    expect(bottom).toBeLessThanOrEqual(900 - 110 + 2);
  });

  it("fits a flight across the antimeridian there, not on the far side of the world", () => {
    // From Fiji, east across 180 degrees, as share mode fits them: from the
    // centre of their bounds, which comes wrapped to the west of it
    const fiji: PathSegment[] = [178.5, 179.5, -179.5].map((lng, i) => ({
      path_id: 1,
      coords: [
        [-17.5 + i * 0.1, lng],
        [-17.4 + i * 0.1, i === 2 ? -178.5 : lng + 1],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 100,
    }));

    const camera = fitTilted(
      fixPoints(fiji),
      { center: [-180, -17.35], zoom: 6 },
      MAP,
      22,
    );

    // Nearly the zoom of the same flight a world away from 180
    const shifted = fiji.map((segment) => ({
      ...segment,
      coords: segment.coords.map(([lat, lng]) => [lat, lng - 170]),
    })) as PathSegment[];
    const away = fitTilted(
      fixPoints(shifted),
      { center: [10, -17.35], zoom: 6 },
      MAP,
      22,
    );
    expect(camera.zoom).toBeCloseTo(away.zoom, 1);
    expect(camera.zoom).toBeGreaterThan(6);
    // Where 180 is on the copy of the world the fixes lie on
    expect(Math.abs(camera.center[0]) - 180).toBeCloseTo(0, 0);
  });

  it("stays at the camera it is given without flights or room, and no closer than the limit", () => {
    const camera = { center: [11, 50] as [number, number], zoom: 5 };
    expect(fitTilted({ ...run, count: 0 }, camera, MAP, 22)).toBe(camera);
    expect(fitTilted(run, camera, { ...MAP, width: 0 }, 22)).toBe(camera);
    expect(fitTilted(run, camera, MAP, 5.5).zoom).toBe(5.5);
  });
});

describe("worldShifts", () => {
  it("moves every start into the 360 degrees after the widest gap between them", () => {
    // England, Fiji and Samoa: the widest gap is between England and Fiji
    const shifts = worldShifts([-1, 179.995, -172]);
    const unwrapped = [-1, 179.995, -172].map((lng, k) => lng + shifts[k]!);
    expect(unwrapped).toEqual([359, 179.995, 188]);
  });

  it("leaves flights that lie together as they are", () => {
    expect(worldShifts([8, 11, 13])).toEqual([0, 0, 0]);
    expect(worldShifts([179.5, 180.4])).toEqual([0, 0]);
    expect(worldShifts([])).toEqual([]);
  });
});
