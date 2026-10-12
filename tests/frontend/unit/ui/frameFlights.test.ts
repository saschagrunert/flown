/**
 * Flights framed on the map as it is tilted: share mode, a flight picked
 * from a list, the intro of a link to shared flights and the replay of all
 * flights fit every fix of them at the tilt and the bearing of the map,
 * across the antimeridian as well.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  flightsCamera,
  frameFlights,
} from "../../../../flown/frontend/ui/frameFlights";
import * as motion from "../../../../flown/frontend/utils/motion";
import { AUTO_ZOOM_FOLLOW } from "../../../../flown/frontend/utils/constants";
import type { PathSegment } from "../../../../flown/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";

/** A flight north from the Rhine, two fixes and one segment */
const RHINE = createSegment({
  path_id: 1,
  coords: [
    [50, 8],
    [51, 8.4],
  ],
});

/** A flight from Fiji east across 180 degrees */
const FIJI: PathSegment[] = [178.5, 179.5, -179.5].map((lng, i) =>
  createSegment({
    path_id: 2,
    coords: [
      [-17.5 + i * 0.1, lng],
      [-17.4 + i * 0.1, i === 2 ? -178.5 : lng + 1],
    ],
  }),
);

describe("frameFlights", () => {
  let app: MockApp;

  beforeEach(() => {
    app = createMockApp({
      currentData: createDataset([{ id: 1 }, { id: 2 }], [RHINE, ...FIJI]),
    });
    vi.spyOn(app.map!.getContainer(), "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 1200, 800),
    );
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The camera the map eased to last */
  const eased = (): Record<string, unknown> =>
    app.map!.easeTo.mock.calls.at(-1)![0] as Record<string, unknown>;

  it("frames the flights at the tilt of the map, which a fit of their bounds took no account of", () => {
    const map = app.map!;
    frameFlights(asMapApp(app), new Set([1]));
    const flat = eased();

    map.jumpTo({ pitch: 60, bearing: 20 });
    frameFlights(asMapApp(app), new Set([1]));
    const tilted = eased();

    // The bearing kept, and the tilt left as the map has it
    expect(tilted["bearing"]).toBe(20);
    expect(tilted).not.toHaveProperty("pitch");
    expect(tilted["zoom"]).not.toBeCloseTo(flat["zoom"] as number, 2);
    // From the fit of their bounds, as [lng, lat] corners
    expect(map.cameraForBounds.mock.calls.at(-1)).toEqual([
      [
        [8, 50],
        [8.4, 51],
      ],
      expect.objectContaining({ bearing: 20, maxZoom: AUTO_ZOOM_FOLLOW }),
    ]);
    expect(tilted["animate"]).toBe(true);
  });

  it("frames a flight across the antimeridian there, not the whole world", () => {
    const map = app.map!;
    map.jumpTo({ pitch: 50 });
    // A flight a world away from 180, to compare with
    const away = flightsCamera(
      asMapApp(app).map!,
      FIJI.map((segment) => ({
        ...segment,
        coords: segment.coords.map(([lat, lng]) => [lat, lng - 170]),
      })) as PathSegment[],
    )!;

    const camera = flightsCamera(asMapApp(app).map!, FIJI)!;

    expect(camera.zoom).toBeCloseTo(away.zoom, 1);
    expect(Math.abs(camera.center[0]) - 180).toBeCloseTo(0, 0);
  });

  it("jumps under reduced motion", () => {
    vi.mocked(motion.prefersReducedMotion).mockReturnValue(true);

    frameFlights(asMapApp(app), new Set([1]));

    expect(eased()["animate"]).toBe(false);
  });

  it("leaves the map alone without fixes to frame", () => {
    frameFlights(asMapApp(app), new Set([9]));

    expect(app.map!.easeTo).not.toHaveBeenCalled();
  });
});
