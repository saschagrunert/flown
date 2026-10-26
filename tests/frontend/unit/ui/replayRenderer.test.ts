import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AirplaneMarker,
  ReplayRenderer,
  findSegmentIndexAtTime,
} from "../../../../flown/frontend/ui/replayRenderer";
import {
  appendTrailSegment,
  trailFeatureCollection,
  truncateTrail,
} from "../../../../flown/frontend/ui/replayTrail";
import {
  AUTO_ZOOM_DURATION_MS,
  AUTO_ZOOM_SETTLE_MS,
  RECENTER_PAN_DURATION_MS,
  SEEK_PAN_THROTTLE_MS,
  liftRoomPx,
} from "../../../../flown/frontend/ui/replayCamera";
import * as motion from "../../../../flown/frontend/utils/motion";
import {
  liftExaggeration,
  liftFt,
  liftOffsetPx,
  ribbonId,
} from "../../../../flown/frontend/calculations/lift";
import { ReplayState } from "../../../../flown/frontend/ui/replayState";
import type { MapApp } from "../../../../flown/frontend/mapApp";
import type { PathSegment } from "../../../../flown/frontend/types";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../flown/frontend/utils/colors";
import * as replayFeature from "../../../../flown/frontend/features/replay";
import { generateSegmentPopupHtml } from "../../../../flown/frontend/utils/htmlGenerators";
import * as mapHelpers from "../../../../flown/frontend/utils/mapHelpers";
import {
  AUTO_ZOOM_MIN,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import type { Map as MapLibreMap } from "maplibre-gl";
import { createMapLibreMock } from "../../testHelpers";
import { Point, type Map as MockMapLibreMap } from "../../../mocks/maplibre-gl";

vi.mock("../../../../flown/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

function makeSegment(overrides: Partial<PathSegment> = {}): PathSegment {
  return {
    coords: [
      [50.0, 8.5],
      [50.01, 8.51],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 120,
    path_id: 0,
    time: 0,
    ...overrides,
  };
}

function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

describe("findSegmentIndexAtTime", () => {
  const segments = [
    makeSegment({ time: 0 }),
    makeSegment({ time: 10 }),
    makeSegment({ time: 20 }),
    makeSegment({ time: 30 }),
  ];

  it("returns the last segment at or before the time", () => {
    expect(findSegmentIndexAtTime(segments, 15)).toBe(1);
    expect(findSegmentIndexAtTime(segments, 20)).toBe(2);
    expect(findSegmentIndexAtTime(segments, 1000)).toBe(3);
  });

  it("returns -1 before the first segment or for empty input", () => {
    expect(findSegmentIndexAtTime(segments, -1)).toBe(-1);
    expect(findSegmentIndexAtTime([], 5)).toBe(-1);
  });
});

/** Consecutive segments that join end to start, 10 s apart */
function makeChain(altitudes: number[]): PathSegment[] {
  return altitudes.map((altitude_ft, i) =>
    makeSegment({
      time: i * 10,
      altitude_ft,
      coords: [
        [50 + i * 0.01, 8 + i * 0.01],
        [50 + (i + 1) * 0.01, 8 + (i + 1) * 0.01],
      ],
    }),
  );
}

describe("trail runs", () => {
  function stateWith(segments: PathSegment[]): ReplayState {
    const state = new ReplayState();
    state.segments = segments;
    return state;
  }

  it("extends the last run while the colour stays the same", () => {
    const state = stateWith(makeChain([3000, 3000, 3000]));

    appendTrailSegment(state, 0, false);
    appendTrailSegment(state, 1, false);
    appendTrailSegment(state, 2, false);

    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]).toMatchObject({ firstIndex: 0, lastIndex: 2 });
    // One vertex more than segments, longitude first
    expect(state.trailRuns[0]!.coords).toEqual([
      [8, 50],
      [8.01, 50.01],
      [8.02, 50.02],
      [8.03, 50.03],
    ]);
    expect(state.lastDrawnIndex).toBe(2);
    expect(state.trailDirty).toBe(true);
  });

  it("starts a run where the colour changes", () => {
    const state = stateWith(makeChain([0, 0, 10000]));

    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    expect(state.trailRuns.map((run) => run.color)).toEqual([
      getColorForAltitude(0, 0, 10000),
      getColorForAltitude(10000, 0, 10000),
    ]);
    expect(state.trailRuns[1]).toMatchObject({ firstIndex: 2, lastIndex: 2 });
  });

  it("carries a run on across the antimeridian instead of round the world", () => {
    const segments = makeChain([3000, 3000, 3000]);
    const lngs = [179.98, 179.99, -179.99, -179.98];
    segments.forEach((segment, i) => {
      segment.coords = [
        [60, lngs[i]!],
        [60, lngs[i + 1]!],
      ];
    });
    const state = stateWith(segments);

    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]!.coords.map(([lng]) => lng)).toEqual([
      179.98,
      179.99,
      expect.closeTo(180.01, 9),
      expect.closeTo(180.02, 9),
    ]);
  });

  it("starts a run where the flight does not join up", () => {
    const segments = makeChain([3000, 3000]);
    segments[1]!.coords = [
      [51, 9],
      [51.01, 9.01],
    ];
    const state = stateWith(segments);

    appendTrailSegment(state, 0, false);
    appendTrailSegment(state, 1, false);

    expect(state.trailRuns).toHaveLength(2);
  });

  it("colours by groundspeed when asked to", () => {
    const state = stateWith([makeSegment({ groundspeed_knots: 150 })]);

    appendTrailSegment(state, 0, true);

    expect(state.trailRuns[0]!.color).toBe(
      getColorForAirspeed(
        150,
        state.colorSpeedRange.min,
        state.colorSpeedRange.max,
      ),
    );
  });

  it("cuts the last run on a backward seek and drops the runs after it", () => {
    const state = stateWith(makeChain([0, 0, 0, 10000, 10000]));
    for (let i = 0; i < 5; i++) appendTrailSegment(state, i, false);
    state.trailDirty = false;

    // Back to 15 s: segments 0 and 1 remain
    truncateTrail(state, 15);

    expect(state.lastDrawnIndex).toBe(1);
    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]).toMatchObject({ firstIndex: 0, lastIndex: 1 });
    expect(state.trailRuns[0]!.coords).toHaveLength(3);
    expect(state.trailDirty).toBe(true);
  });

  it("extends a cut run again when the replay moves on", () => {
    const state = stateWith(makeChain([0, 0, 0]));
    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    truncateTrail(state, 5);
    appendTrailSegment(state, 1, false);

    expect(state.trailRuns).toHaveLength(1);
    expect(state.trailRuns[0]!.coords).toHaveLength(3);
  });

  it("empties the trail on a seek before the first segment", () => {
    const state = stateWith(makeChain([0, 10000]));
    state.segments[0]!.time = 5;
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    truncateTrail(state, 1);

    expect(state.trailRuns).toEqual([]);
    expect(state.lastDrawnIndex).toBe(-1);
  });

  it("empties the trail on a seek back to the start", () => {
    // The first segment starts at 0 s: kept, it was drawn whole ahead of
    // the airplane, which a replay at 0 s does not draw at all
    const state = stateWith(makeChain([0, 10000]));
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    truncateTrail(state, 0);

    expect(state.trailRuns).toEqual([]);
    expect(state.lastDrawnIndex).toBe(-1);
  });

  it("leaves a trail that needs no cutting clean", () => {
    const state = stateWith(makeChain([0, 0]));
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);
    state.trailDirty = false;

    truncateTrail(state, 15);

    expect(state.trailDirty).toBe(false);
    expect(state.lastDrawnIndex).toBe(1);
  });

  it("runs along the flight's curve, cut at the fixes, when it has one", () => {
    // A right angle at the second fix, which the curve rounds
    const segments = makeChain([0, 0, 10000]);
    segments[1]!.coords = [
      [50.01, 8.01],
      [50.01, 8.03],
    ];
    segments[2]!.coords = [
      [50.01, 8.03],
      [50.01, 8.05],
    ];
    const state = stateWith(segments);
    state.smoothed = replayFeature.replayCurve(segments, () => 0);
    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);

    const [first, second] = state.trailRuns;
    const chain = state.smoothed.chains[0]!;
    // The points of the curve, longitude first, the colour changing at the
    // fix between the second and the third segment
    expect(first!.coords).toEqual(
      chain.points
        .slice(0, state.smoothed.to[1]! + 1)
        .map(([lat, lng]) => [lng, lat]),
    );
    expect(first!.coords.length).toBeGreaterThan(3);
    expect(second!.coords[0]).toEqual([8.03, 50.01]);
    expect(first!.coords[first!.coords.length - 1]).toEqual([8.03, 50.01]);

    // A seek back into the second segment keeps the points of the first two
    truncateTrail(state, 15);
    expect(state.trailRuns).toHaveLength(1);
    expect(first!.coords).toHaveLength(state.smoothed.to[1]! + 1);
  });

  it("ends the line at the airplane, part way along its segment", () => {
    const segments = makeChain([0, 0, 0]);
    const state = stateWith(segments);
    state.smoothed = replayFeature.replayCurve(segments, () => 0);
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);
    const at = replayFeature.replayPoint(state.smoothed, 1, 0.3)!;
    state.trailTip = { index: 1, ...at };

    const line = trailFeatureCollection(state, 13, 11).features[0]!.geometry
      .coordinates as [number, number][];

    // Not the end of the segment, 70 % of it ahead of the airplane
    expect(line[line.length - 1]).toEqual([at.position[1], at.position[0]]);
    expect(line).toHaveLength(at.point + 2);
    // The run itself keeps the whole segment, for the next frame
    expect(state.trailRuns[0]!.coords[2]).toEqual([8.02, 50.02]);
  });

  it("turns the runs into one coloured line each", () => {
    const state = stateWith(makeChain([0, 10000]));
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    const data = trailFeatureCollection(state, 13, 11);

    expect(data.type).toBe("FeatureCollection");
    expect(data.features).toHaveLength(2);
    expect(data.features[0]).toEqual({
      type: "Feature",
      properties: { color: getColorForAltitude(0, 0, 10000) },
      geometry: {
        type: "LineString",
        coordinates: [
          [8, 50],
          [8.01, 50.01],
        ],
      },
    });
  });
});

describe("trail runs in the 3D view", () => {
  /** The trail's flight along its curve at its height above 1000 ft */
  function smoothed(segments: PathSegment[]): ReplayState["smoothed"] {
    return replayFeature.replayCurve(segments, (i) =>
      Math.max((segments[i]!.altitude_ft ?? 0) - 1000, 0),
    );
  }

  it("writes each run as ribbons cut from the smoothed flight, in place of its line", () => {
    const segments = makeChain([1000, 1100]);
    const state = new ReplayState();
    state.segments = segments;
    state.smoothed = smoothed(segments);
    state.lifted = true;
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    const data = trailFeatureCollection(state, 13, 11);

    // The lines' source is another one
    expect(data.features.every((f) => f.geometry.type === "MultiPolygon")).toBe(
      true,
    );
    // Cut for the level of the relief under them, and exaggerated as it
    // is, as the flights' ribbons are
    expect(data.features.every((f) => f.properties.l === 11)).toBe(true);
    const heights = data.features.map((ribbon) => ribbon.properties.h!);
    expect(heights[0]).toBe(0);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(Math.max(...heights)).toBeLessThanOrEqual(100);
    expect(heights.length).toBeGreaterThanOrEqual(1 + 100 / 20);
  });

  it("writes no ribbon while the trail is flat", () => {
    const state = new ReplayState();
    state.segments = makeChain([1000, 1100]);
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);

    expect(
      trailFeatureCollection(state, 13, 11).features.every(
        (feature) => feature.geometry.type === "LineString",
      ),
    ).toBe(true);
  });

  it("cuts only the runs that grew or changed their width again", () => {
    // Two runs: the climb changes the colour after the first segment
    const segments = makeChain([1000, 1000, 9000, 9000]);
    const state = new ReplayState();
    state.segments = segments;
    state.smoothed = smoothed(segments);
    state.lifted = true;
    for (let i = 0; i < 3; i++) appendTrailSegment(state, i, false);
    expect(state.trailRuns).toHaveLength(2);
    const [first, second] = state.trailRuns;
    const geometryOf = (data: ReturnType<typeof trailFeatureCollection>) =>
      data.features.map((feature) => feature.geometry);

    const before = geometryOf(trailFeatureCollection(state, 13, 11));
    const cutFirst = state.trailPieces.get(first!)!.pieces;
    const cutSecond = state.trailPieces.get(second!)!.pieces;
    appendTrailSegment(state, 3, false);
    const after = geometryOf(trailFeatureCollection(state, 13, 11));

    // The first run is the same, down to its geometry; the second grew
    expect(state.trailPieces.get(first!)!.pieces).toBe(cutFirst);
    expect(state.trailPieces.get(second!)!.pieces).not.toBe(cutSecond);
    expect(after[0]).toBe(before[0]);

    // Another zoom level, and every run is cut again, as wide as it asks
    trailFeatureCollection(state, 9, 9);
    expect(state.trailPieces.get(first!)!.pieces).not.toBe(cutFirst);
    expect(state.trailPieces.get(first!)!.widthZoom).toBe(9);
  });

  it("ends the ribbons at the airplane, and cuts only its part of a segment each frame", () => {
    const segments = makeChain([1000, 1500, 2000]);
    const state = new ReplayState();
    state.segments = segments;
    state.smoothed = smoothed(segments);
    state.lifted = true;
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);
    const [run] = state.trailRuns;
    // A third of the way along the second segment
    const at = replayFeature.replayPoint(state.smoothed!, 1, 1 / 3)!;
    state.trailTip = { index: 1, ...at };

    const pieces = trailFeatureCollection(state, 13, 11).features;
    // The end of the last quad is the airplane, between its two edges
    const quads = pieces[pieces.length - 1]!.geometry
      .coordinates as number[][][][];
    const [, left, right] = quads[quads.length - 1]![0]!;
    expect((left![0]! + right![0]!) / 2).toBeCloseTo(at.position[1], 9);
    expect((left![1]! + right![1]!) / 2).toBeCloseTo(at.position[0], 9);
    // The run is cut up to the segment the airplane is on; the rest of the
    // way is cut again for every frame
    const cut = state.trailPieces.get(run!)!;
    expect(cut.end).toBe(1);
    state.trailTip = {
      index: 1,
      ...replayFeature.replayPoint(state.smoothed!, 1, 2 / 3)!,
    };
    trailFeatureCollection(state, 13, 11);
    expect(state.trailPieces.get(run!)).toBe(cut);
  });

  it("gives the ribbons the ground of the levels around, up to the airplane", () => {
    const segments = makeChain([3000, 3000]);
    const state = new ReplayState();
    state.segments = segments;
    // Over ground 80 ft lower a level further out, 320 ft two levels out,
    // in steps the offsets of zoom 8 are rounded to
    const none = new Float64Array(segments.length);
    state.smoothed = replayFeature.replayCurve(
      segments,
      (i) => segments[i]!.altitude_ft ?? 0,
      () => 1000,
      [
        Float64Array.from(segments, () => 320),
        Float64Array.from(segments, () => 80),
        none,
      ],
    );
    state.lifted = true;
    for (let i = 0; i < 2; i++) appendTrailSegment(state, i, false);
    state.trailTip = {
      index: 1,
      ...replayFeature.replayPoint(state.smoothed, 1, 1 / 2)!,
    };

    const { features } = trailFeatureCollection(state, 8, 8);

    expect(features.length).toBeGreaterThan(0);
    for (const { properties } of features) {
      expect(properties).toMatchObject({ l: 8, k: 8, "o-2": 320, "o-1": 80 });
      expect(properties["o1"]).toBeUndefined();
    }
    // Cut in a later visit of the level, the map knows them by its id
    const later = trailFeatureCollection(state, 8, 8, 2).features;
    expect(new Set(later.map(({ properties }) => properties.k))).toEqual(
      new Set([ribbonId(8, 2)]),
    );
  });
});

describe("AirplaneMarker", () => {
  let map: MockMapLibreMap;
  let onActivate: ReturnType<typeof vi.fn<() => void>>;
  let airplane: AirplaneMarker;

  beforeEach(() => {
    map = createMapLibreMock();
    onActivate = vi.fn<() => void>();
    airplane = new AirplaneMarker(
      map as unknown as MapLibreMap,
      [48, 16],
      onActivate,
    );
  });

  afterEach(() => airplane.remove());

  it("is a button on the map, centred on the position", () => {
    const element = airplane.getElement();

    expect(element.tagName).toBe("BUTTON");
    expect(element.type).toBe("button");
    expect(element.className).toContain("replay-airplane-root");
    expect(element.getAttribute("aria-label")).toBe("Aircraft position");
    // The stylesheet owns the stacking: an inline value would beat it
    expect(element.style.zIndex).toBe("");
    expect(element.querySelector(".replay-airplane-icon svg")).not.toBeNull();
    expect(map.getCanvasContainer().contains(element)).toBe(true);
    expect(
      (airplane.marker as unknown as { options: unknown }).options,
    ).toMatchObject({ anchor: "center" });
    expect(airplane.position()).toEqual([48, 16]);
  });

  it("lies on the map, tilted with it, and turns on its own", () => {
    // The heading is turned inside the marker (see iconHeading), so the
    // marker only takes the map's tilt, not its bearing
    expect(
      (airplane.marker as unknown as { options: unknown }).options,
    ).toMatchObject({ pitchAlignment: "map", rotationAlignment: "viewport" });
  });

  describe("setLift", () => {
    /** The last offset the popup was given, by anchor */
    const popupOffset = (): Record<string, [number, number]> =>
      vi.mocked(airplane.popup.setOffset).mock.calls.at(-1)![0] as Record<
        string,
        [number, number]
      >;
    /** What MapLibre makes of a popup offset of 16 px, by anchor */
    const standard: Record<string, [number, number]> = {
      center: [0, 0],
      top: [0, 16],
      "top-left": [11, 11],
      "top-right": [-11, 11],
      bottom: [0, -16],
      "bottom-left": [11, -11],
      "bottom-right": [-11, -11],
      left: [16, 0],
      right: [-16, 0],
    };

    it("draws the airplane and points its popup the lift higher", () => {
      airplane.openPopup();
      airplane.setLift(30);

      expect(airplane.marker.setOffset).toHaveBeenLastCalledWith([0, -30]);
      const offset = popupOffset();
      expect(Object.keys(offset).sort()).toEqual(Object.keys(standard).sort());
      for (const [anchor, [x, y]] of Object.entries(standard)) {
        // Whichever side it opens on, only up by the lift
        expect(offset[anchor]).toEqual([x, y - 30]);
      }
    });

    it("points a closed popup only as it opens, not on every lift", () => {
      airplane.setLift(30);
      airplane.setLift(40);
      expect(airplane.popup.setOffset).not.toHaveBeenCalled();

      airplane.openPopup();
      expect(popupOffset()["bottom"]).toEqual([0, -16 - 40]);
    });

    it("gives the standard offsets back on the ground", () => {
      airplane.openPopup();
      airplane.setLift(30);
      airplane.setLift(0);

      expect(airplane.marker.setOffset).toHaveBeenLastCalledWith([0, -0]);
      expect(popupOffset()).toEqual(
        Object.fromEntries(
          Object.entries(standard).map(([anchor, [x, y]]) => [
            anchor,
            [x, y - 0],
          ]),
        ),
      );
    });

    it("writes nothing when the lift has not changed", () => {
      airplane.setLift(12);
      vi.mocked(airplane.marker.setOffset).mockClear();
      vi.mocked(airplane.popup.setOffset).mockClear();

      airplane.setLift(12);

      expect(airplane.marker.setOffset).not.toHaveBeenCalled();
      expect(airplane.popup.setOffset).not.toHaveBeenCalled();
    });
  });

  it("closes its popup once the globe has turned the airplane away", () => {
    map.setProjection({ type: "globe" });
    airplane.openPopup();

    map.jumpTo({ center: [60, 40] });
    map.emit("move");
    expect(airplane.isPopupOpen()).toBe(true);

    map.jumpTo({ center: [-160, 40] });
    map.emit("move");
    expect(airplane.isPopupOpen()).toBe(false);
  });

  it("creates a popup the map's clicks and focus leave alone", () => {
    expect(
      (airplane.popup as unknown as { options: unknown }).options,
    ).toMatchObject({
      maxWidth: "none",
      closeOnClick: false,
      focusAfterOpen: false,
    });
    expect(airplane.marker.getPopup()).toBeFalsy();
  });

  it("asks for the popup on a click, which it leaves to the map as well", () => {
    // The map's handler tells a click on a marker by its target; a marker
    // that stops its events would be one more thing to remember
    const mapClick = vi.fn();
    map.getCanvasContainer().addEventListener("click", mapClick);

    airplane.getElement().click();

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(mapClick).toHaveBeenCalledTimes(1);
  });

  it("opens from the keyboard: Enter on a focused button is a click", () => {
    // Focus needs the map to be part of the document
    document.body.append(map.getContainer());
    const element = airplane.getElement();
    element.focus();
    expect(document.activeElement).toBe(element);
    map.getContainer().remove();

    // jsdom does not turn the key into the click a browser makes of it
    element.click();

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("closes an open popup on the next click", () => {
    airplane.openPopup();
    expect(airplane.isPopupOpen()).toBe(true);

    airplane.getElement().click();

    expect(airplane.isPopupOpen()).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("takes Escape for its open popup alone, and leaves the rest to the page", () => {
    const escape = (): KeyboardEvent => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      airplane.getElement().dispatchEvent(event);
      return event;
    };

    airplane.openPopup();
    expect(escape().defaultPrevented).toBe(true);
    expect(airplane.isPopupOpen()).toBe(false);

    // With nothing to close, the replay's own Escape gets it
    expect(escape().defaultPrevented).toBe(false);
  });

  it("keeps the popup open through a double click or a double tap", () => {
    const element = airplane.getElement();
    // The caller opens it; here only whether it is asked to matters
    onActivate.mockImplementation(() => airplane.openPopup());

    for (const detail of [1, 2, 3]) {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
    }

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(airplane.isPopupOpen()).toBe(true);
  });

  it("tells assistive technology whether its popup is open", () => {
    const element = airplane.getElement();
    expect(element.getAttribute("aria-expanded")).toBe("false");

    airplane.openPopup();
    expect(element.getAttribute("aria-expanded")).toBe("true");

    airplane.closePopup();
    expect(element.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the popup at the marker", () => {
    airplane.setPopupContent("<p>here</p>");
    airplane.openPopup();

    expect(airplane.popup.getLngLat()).toMatchObject({ lng: 16, lat: 48 });
    expect(airplane.popup.getElement().innerHTML).toContain("<p>here</p>");
    expect(map.getContainer().contains(airplane.popup.getElement())).toBe(true);
  });

  it("takes an open popup along, and leaves a closed one alone", () => {
    airplane.setLatLng([48.5, 16.5]);
    expect(airplane.popup.setLngLat).not.toHaveBeenCalled();

    airplane.openPopup();
    airplane.setLatLng([49, 17]);

    expect(airplane.position()).toEqual([49, 17]);
    expect(airplane.popup.getLngLat()).toMatchObject({ lng: 17, lat: 49 });
  });

  it("takes the marker and the popup off the map", () => {
    airplane.openPopup();

    airplane.remove();

    expect(airplane.isPopupOpen()).toBe(false);
    expect(map.getCanvasContainer().contains(airplane.getElement())).toBe(
      false,
    );
  });
});

describe("ReplayRenderer", () => {
  let renderer: ReplayRenderer;
  let map: MockMapLibreMap;
  let mockApp: {
    map: MockMapLibreMap;
    altitudeVisible: boolean;
    airspeedVisible: boolean;
    replayActive: boolean;
    reliefLevel: number;
    relief: { epoch: number };
    signal: AbortSignal;
  };
  let mockReplayManager: { state: ReplayState };
  let frames: FrameRequestCallback[];

  /** An airplane on the mock map; a click on it refreshes its popup */
  function makeAirplane(): AirplaneMarker {
    return new AirplaneMarker(map as unknown as MapLibreMap, [0, 0], () =>
      renderer.updateAirplanePopup(mockReplayManager.state),
    );
  }

  /** Where the map says the airplane is, in pixels of an 800 x 600 map */
  function airplaneAt(x: number, y: number): void {
    map.project.mockReturnValue({ x, y });
  }

  /** Run the animation frames asked for so far */
  function runFrame(): void {
    const due = frames;
    frames = [];
    due.forEach((callback) => callback(performance.now()));
  }

  function trailSource() {
    return map.source(MAP_SOURCES.replayTrail);
  }

  beforeEach(() => {
    vi.clearAllMocks();

    const timeDisplay = document.createElement("div");
    timeDisplay.id = "replay-time-display";
    const slider = document.createElement("input");
    slider.id = "replay-slider";
    slider.type = "range";
    const sliderStart = document.createElement("span");
    sliderStart.id = "replay-slider-start";
    document.body.append(timeDisplay, slider, sliderStart);

    frames = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {
      frames = [];
    });

    map = createMapLibreMock();
    // jsdom lays nothing out, so the container is given its size
    const container = map.getContainer();
    Object.defineProperty(container, "clientWidth", { value: 800 });
    Object.defineProperty(container, "clientHeight", { value: 600 });
    airplaneAt(400, 300);

    mockApp = {
      map,
      altitudeVisible: true,
      airspeedVisible: false,
      replayActive: false,
      reliefLevel: 13,
      relief: { epoch: 0 },
      signal: new AbortController().signal,
    };

    mockReplayManager = {
      state: new ReplayState(),
    };

    renderer = new ReplayRenderer(mockApp as unknown as MapApp);
  });

  afterEach(() => {
    mockReplayManager.state.airplaneMarker?.remove();
    ["replay-time-display", "replay-slider", "replay-slider-start"].forEach(
      (id) => document.getElementById(id)?.remove(),
    );
    vi.useRealTimers();
  });

  describe("updateAirplanePopup", () => {
    it("skips when no marker", () => {
      mockApp.replayActive = true;
      mockReplayManager.state.airplaneMarker = null;
      mockReplayManager.state.segments = [makeSegment()];

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });

    it("skips when not active", () => {
      mockApp.replayActive = false;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment()];

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(airplane.isPopupOpen()).toBe(false);
    });

    it("finds current segment by time", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 15;
      const segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[1] }),
      );
      expect(airplane.popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(airplane.isPopupOpen()).toBe(true);
    });

    it("opens on a click on the airplane", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      airplane.getElement().click();

      expect(airplane.isPopupOpen()).toBe(true);
      expect(airplane.popup.getElement().innerHTML).toContain("popup");
    });

    it("shows where the aircraft is, not where its segment ends", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      // Part way along the segment, as the frame loop leaves it
      airplane.setLatLng([50.25, 8.25]);

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ position: [50.25, 8.25] }),
      );
    });

    it("uses the given index instead of searching", () => {
      mockApp.replayActive = true;
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 25;
      const segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
      ];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(mockReplayManager.state, 0);

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[0] }),
      );
    });

    it("falls back to first segment when currentTime is before all", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 0;
      const segments = [makeSegment({ time: 5 }), makeSegment({ time: 10 })];
      mockReplayManager.state.segments = segments;

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[0] }),
      );
      expect(airplane.isPopupOpen()).toBe(true);
    });

    it("skips when no segments", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [];

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(airplane.isPopupOpen()).toBe(false);
    });

    it("refills an open popup without opening it again", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      mockReplayManager.state.currentTime = 5;
      airplane.openPopup();
      vi.mocked(airplane.popup.addTo).mockClear();

      renderer.updateAirplanePopup(mockReplayManager.state);

      expect(airplane.popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      expect(airplane.popup.addTo).not.toHaveBeenCalled();
    });

    it("pans the popup into view while paused, and never while playing", () => {
      const pan = vi.spyOn(mapHelpers, "panPopupIntoView");
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      mockReplayManager.state.playing = true;
      renderer.updateAirplanePopup(mockReplayManager.state);
      expect(pan).not.toHaveBeenCalled();

      mockReplayManager.state.playing = false;
      renderer.updateAirplanePopup(mockReplayManager.state);
      expect(pan).toHaveBeenCalledWith(map, airplane.popup, undefined, true);
    });
  });

  describe("ensureReadout", () => {
    it("builds the three cells once", () => {
      const panel = document.createElement("div");

      const first = renderer.ensureReadout(panel);
      const second = renderer.ensureReadout(panel);

      expect(second).toBe(first);
      expect(panel.querySelectorAll(".replay-readout-cell")).toHaveLength(3);
      expect(first.querySelector(".replay-readout-value")!.textContent).toBe(
        "—",
      );
    });

    it("places the strip inside the panel's inner wrapper when present", () => {
      const panel = document.createElement("div");
      const inner = document.createElement("div");
      inner.id = "replay-controls-inner";
      panel.append(inner);

      const strip = renderer.ensureReadout(panel);

      expect(strip.parentElement).toBe(inner);
    });
  });

  describe("updateDisplay", () => {
    function callUpdateDisplay(isManualSeek = false): void {
      renderer.updateDisplay(mockReplayManager.state, isManualSeek);
    }

    it("leaves the map alone while it has lost its WebGL context, and catches up after", () => {
      mapHelpers.followContextLoss(map as unknown as MapLibreMap);
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.airplaneMarker = makeAirplane();
      state.segments = makeChain([1000, 2000, 3000]);
      state.smoothed = replayFeature.replayCurve(state.segments, () => 0);
      state.maxTime = 30;
      state.currentTime = 5;
      // A seek off the map: the camera jumps, and its rest is due in a frame
      airplaneAt(-100, -100);
      callUpdateDisplay(true);
      airplaneAt(400, 300);
      state.playing = true;
      expect(map.jumpTo).toHaveBeenCalled();
      vi.mocked(map.jumpTo).mockClear();
      trailSource().setData.mockClear();
      const rests = () =>
        vi.mocked(map.fire).mock.calls.filter(([type]) => type === "moveend")
          .length;

      // MapLibre drops its style until the context is back: asking the map
      // throws, as its projection did in every frame of a replay, and so
      // did the listeners told of the camera's rest
      map.emit("webglcontextlost");
      runFrame();
      runFrame();
      expect(rests()).toBe(0);
      map.getProjection.mockImplementation(() => {
        throw new TypeError("Cannot read properties of null");
      });
      state.currentTime = 25;
      expect(() => callUpdateDisplay()).not.toThrow();
      runFrame();
      expect(el("replay-time-display").textContent).toBe("0:25 / 0:30");
      expect(trailSource().setData).not.toHaveBeenCalled();
      expect(state.airplaneMarker.position()[0]).toBeLessThan(50.02);

      map.getProjection.mockReset();
      map.emit("webglcontextrestored");
      map.emit("style.load");
      runFrame();
      expect(rests()).toBe(1);
      callUpdateDisplay();
      // The trail up to the airplane where it is now
      expect(trailSource().setData).toHaveBeenCalled();
      expect(state.lastDrawnIndex).toBe(2);
      expect(state.airplaneMarker.position()[0]).toBeGreaterThan(50.02);
    });

    it("updates time display text", () => {
      mockReplayManager.state.currentTime = 65;
      mockReplayManager.state.maxTime = 300;

      callUpdateDisplay();

      expect(el("replay-time-display").textContent).toBe("1:05 / 5:00");
    });

    it("updates slider value and spoken value text", () => {
      mockReplayManager.state.currentTime = 42;
      mockReplayManager.state.maxTime = 300;

      callUpdateDisplay();

      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.value).toBe("42");
      expect(slider.getAttribute("aria-valuetext")).toBe("0:42 of 5:00");
    });

    it("works without the replay control elements", () => {
      el("replay-time-display").remove();
      el("replay-slider").remove();
      el("replay-slider-start").remove();
      mockReplayManager.state.currentTime = 5;

      expect(() => callUpdateDisplay()).not.toThrow();
    });

    it("draws segments incrementally", () => {
      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = makeChain([3000, 3000, 3000]);

      callUpdateDisplay();

      expect(mockReplayManager.state.lastDrawnIndex).toBe(1);
      expect(mockReplayManager.state.currentIndex).toBe(1);
      expect(mockReplayManager.state.trailRuns).toHaveLength(1);
      expect(mockReplayManager.state.trailRuns[0]!.coords).toHaveLength(3);
    });

    it("draws nothing while the replay layer is not set up", () => {
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = makeChain([3000, 3000]);

      callUpdateDisplay();
      runFrame();

      expect(mockReplayManager.state.trailRuns).toEqual([]);
      expect(trailSource().setData).not.toHaveBeenCalled();
    });

    it("does not draw segments at time 0", () => {
      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      runFrame();

      expect(mockReplayManager.state.trailRuns).toEqual([]);
      expect(mockReplayManager.state.lastDrawnIndex).toBe(-1);
      expect(trailSource().setData).not.toHaveBeenCalled();
    });

    it("starts drawing after the last drawn index", () => {
      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.lastDrawnIndex = 1;
      mockReplayManager.state.currentTime = 30;
      mockReplayManager.state.segments = makeChain([3000, 3000, 3000]);

      callUpdateDisplay();

      expect(mockReplayManager.state.trailRuns).toHaveLength(1);
      expect(mockReplayManager.state.trailRuns[0]).toMatchObject({
        firstIndex: 2,
        lastIndex: 2,
      });
      expect(mockReplayManager.state.lastDrawnIndex).toBe(2);
    });

    it("hands the trail to the map once per frame, however often it grew", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0, 10000, 10000]);

      // A drag of the slider: several positions before the next frame
      state.currentTime = 5;
      callUpdateDisplay(true);
      state.currentTime = 15;
      callUpdateDisplay(true);
      state.currentTime = 25;
      callUpdateDisplay(true);
      expect(trailSource().setData).not.toHaveBeenCalled();

      runFrame();

      expect(trailSource().setData).toHaveBeenCalledTimes(1);
      expect(trailSource().data).toEqual(trailFeatureCollection(state, 13, 11));
      expect(
        (trailSource().data as { features: unknown[] }).features,
      ).toHaveLength(2);
      expect(state.trailDirty).toBe(false);
    });

    it("writes nothing for frames that drew no new segment", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0]);
      state.currentTime = 5;
      callUpdateDisplay();
      runFrame();
      expect(trailSource().setData).toHaveBeenCalledTimes(1);

      // Still on segment 0: the airplane moves, the trail does not
      for (const time of [6, 7, 8]) {
        state.currentTime = time;
        callUpdateDisplay();
        runFrame();
      }
      expect(trailSource().setData).toHaveBeenCalledTimes(1);

      state.currentTime = 12;
      callUpdateDisplay();
      runFrame();
      expect(trailSource().setData).toHaveBeenCalledTimes(2);
    });

    it("cuts the trail on a backward seek and tells the map", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0, 0]);
      state.currentTime = 25;
      callUpdateDisplay();
      runFrame();

      renderer.removeSegmentsAfter(mockReplayManager.state, 5);
      runFrame();

      expect(state.lastDrawnIndex).toBe(0);
      expect(trailSource().setData).toHaveBeenCalledTimes(2);
      expect(trailSource().data).toMatchObject({
        features: [
          {
            geometry: {
              coordinates: [
                [8, 50],
                [8.01, 50.01],
              ],
            },
          },
        ],
      });
    });

    it("writes the emptied trail after a reset", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0, 0]);
      state.currentTime = 15;
      callUpdateDisplay();
      runFrame();

      state.resetDrawState();
      callUpdateDisplay();
      runFrame();

      expect(trailSource().data).toEqual({
        type: "FeatureCollection",
        features: [],
      });
    });

    it("drops a pending write when asked to", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.segments = makeChain([0]);
      state.currentTime = 5;
      callUpdateDisplay();

      renderer.cancelTrailFlush();
      runFrame();

      expect(trailSource().setData).not.toHaveBeenCalled();
    });

    it("scans forward from the previous index while playing", () => {
      mockReplayManager.state.currentIndex = 1;
      mockReplayManager.state.currentTime = 25;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.currentIndex).toBe(2);
    });

    it("searches again when the time moved backwards", () => {
      mockReplayManager.state.currentIndex = 3;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.currentIndex).toBe(0);
    });

    it("positions airplane marker at segment end", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(airplane.position()).toEqual([50.01, 8.51]);
      // Longitude first on its way to the map
      expect(airplane.marker.setLngLat).toHaveBeenLastCalledWith([8.51, 50.01]);
    });

    it("moves the airplane along its segment between two times", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
      ];

      callUpdateDisplay();

      const [lat, lon] = airplane.position();
      expect(lat).toBeCloseTo(50.005);
      expect(lon).toBeCloseTo(8.505);
    });

    it("moves the airplane the short way across the antimeridian", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      const across: PathSegment["coords"] = [
        [50.0, 179.99],
        [50.01, -179.99],
      ];
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, coords: across }),
        makeSegment({ time: 10 }),
      ];

      callUpdateDisplay();

      // At the antimeridian, not half way round the world at 0 degrees
      const [, lon] = airplane.position();
      expect(lon).toBeCloseTo(180);
    });

    it("draws with airspeed colors when airspeed is visible and altitude is not", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.lastDrawnIndex = -1;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 150 }),
      ];

      callUpdateDisplay();

      const { min: colorMinSpeed, max: colorMaxSpeed } =
        mockReplayManager.state.colorSpeedRange;
      expect(mockReplayManager.state.trailRuns[0]!.color).toBe(
        getColorForAirspeed(150, colorMinSpeed, colorMaxSpeed),
      );
    });

    it("falls back to altitude colors for segments without groundspeed", () => {
      mockApp.airspeedVisible = true;
      mockApp.altitudeVisible = false;

      mockReplayManager.state.layerActive = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0, groundspeed_knots: 0 }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.trailRuns[0]!.color).toBe(
        getColorForAltitude(3000, 0, 10000),
      );
    });

    it("falls back to first segment coords when no lastSegment", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 0;
      mockReplayManager.state.segments = [
        makeSegment({
          time: 5,
          coords: [
            [51.0, 9.0],
            [51.01, 9.01],
          ],
        }),
      ];

      callUpdateDisplay();

      expect(airplane.position()).toEqual([51.0, 9.0]);
    });

    it("applies rotation transform to airplane icon", () => {
      const airplane = makeAirplane();
      const iconDiv = airplane
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(iconDiv.style.transform).toContain("rotate(");
      expect(iconDiv.style.transform).toContain("translate3d(0,0,0)");
      expect(mockReplayManager.state.lastBearing).not.toBeNull();
      // The marker itself is never rotated: MapLibre positions it
      expect(airplane.marker.setRotation).not.toHaveBeenCalled();
    });

    it("turns the icon the short way when the heading crosses north", () => {
      const airplane = makeAirplane();
      const iconDiv = airplane
        .getElement()
        .querySelector<HTMLElement>(".replay-airplane-icon")!;
      const state = mockReplayManager.state;
      state.airplaneMarker = airplane;
      state.segments = [makeSegment({ time: 0 })];
      state.smoothed = replayFeature.replayCurve(state.segments, () => 0);
      const bearing = (track: number, time: number): void => {
        vi.spyOn(replayFeature, "replayPoint").mockReturnValue({
          position: [50, 8.5],
          heightFt: 0,
          track,
          point: 0,
        });
        // Long enough after the last frame for the damping to have settled
        state.currentTime = time;
        callUpdateDisplay();
      };

      bearing(350, 5);
      expect(iconDiv.style.transform).toContain("rotate(350deg)");

      // 350 to 10 degrees is a 20 degree turn: 370, not a transition back
      // through 180 to 10
      bearing(10, 105);
      expect(iconDiv.style.transform).toContain("rotate(370deg)");

      bearing(340, 205);
      expect(iconDiv.style.transform).toContain("rotate(340deg)");
    });

    describe("in the 3D view", () => {
      let airplane: AirplaneMarker;

      beforeEach(() => {
        airplane = makeAirplane();
        mockReplayManager.state.airplaneMarker = airplane;
        mockReplayManager.state.currentTime = 15;
        // Halfway along a segment climbing from 1000 to 2000 ft
        mockReplayManager.state.segments = makeChain([1000, 2000, 2000]);
        // The last at the speed of the one before, which then keeps its own
        // all along (see replayCurve)
        mockReplayManager.state.segments.at(-1)!.groundspeed_knots = 0;
        lifted(true);
      });

      /** The trail lifted, as ReplayManager does it, or flat */
      const lifted = (on: boolean): void => {
        const state = mockReplayManager.state;
        state.lifted = on;
        // Standing on 1000 ft all along
        state.groundFt = new Float64Array(state.segments.length).fill(1000);
        // The curve at its height, which a flat replay has as well
        state.smoothed = replayFeature.replayCurve(state.segments, (i) =>
          liftFt(state.segments[i]!.altitude_ft ?? 0, state.groundFt[i]!),
        );
      };

      /** How far up the marker is drawn, in pixels */
      /** How far up the marker is drawn, in pixels; 0 before it is moved */
      const lift = (): number => {
        const calls = vi.mocked(airplane.marker.setOffset).mock.calls;
        const last = calls[calls.length - 1]?.[0] as
          [number, number] | undefined;
        return last ? -last[1] : 0;
      };

      it("ends the trail at the airplane's new height when the ground under it changes", () => {
        const state = mockReplayManager.state;
        state.layerActive = true;
        callUpdateDisplay();
        const before = state.trailTip!.heightFt;

        // The same place and time, over other ground: the terrain or the
        // relief changed where the airplane stands
        state.groundFt = new Float64Array(state.segments.length).fill(0);
        state.smoothed = replayFeature.replayCurve(state.segments, (i) =>
          liftFt(state.segments[i]!.altitude_ft ?? 0, state.groundFt[i]!),
        );
        state.trailDirty = false;
        callUpdateDisplay();

        expect(state.trailTip!.heightFt).not.toBe(before);
        expect(state.trailDirty).toBe(true);
      });

      it("ends the trail at the airplane's new offsets when only the ground of the levels around changes", () => {
        const state = mockReplayManager.state;
        state.layerActive = true;
        /** The curve over the same ground, with `levels` the ground around */
        const curve = (levels: number): void => {
          state.smoothed = replayFeature.replayCurve(
            state.segments,
            (i) => liftFt(state.segments[i]!.altitude_ft ?? 0, 1000),
            () => 1000,
            [Float64Array.from(state.segments, () => levels)],
          );
        };
        curve(80);
        callUpdateDisplay();
        const before = state.trailTip!;
        state.trailDirty = false;

        // The same place, time and height: only the ground a level further
        // out changed (a tile of the terrain came in)
        curve(320);
        callUpdateDisplay();

        expect(state.trailTip!.position).toEqual(before.position);
        expect(state.trailTip!.heightFt).toBe(before.heightFt);
        expect(state.trailTip!.offsetsFt).not.toEqual(before.offsetsFt);
        expect(state.trailDirty).toBe(true);

        // The same offsets again, in a new array: nothing to write
        state.trailDirty = false;
        curve(320);
        callUpdateDisplay();
        expect(state.trailDirty).toBe(false);
      });

      it("lifts the airplane to its height on a tilted map, along its segment", () => {
        // The middle of the map far south of the airplane, at 50 degrees
        map.jumpTo({ center: [8, 20], zoom: 13, pitch: 60 });

        callUpdateDisplay();

        // 500 ft above the ground, halfway up the climb, at the scale of the
        // map's centre, which MapLibre raises every extrusion by
        expect(lift()).toBeCloseTo(
          liftOffsetPx(
            map as unknown as MapLibreMap,
            20,
            500,
            liftExaggeration(mockApp.reliefLevel),
          ),
          0,
        );
        expect(lift()).toBeGreaterThan(0);
      });

      it("lifts it above the relief of the map's zoom, as its trail stands on it", () => {
        const state = mockReplayManager.state;
        // Cut for level 10, over ground 200 ft lower at the next level in
        state.groundLevel = 10;
        const lower = Float64Array.from(state.segments, () => 200);
        const none = new Float64Array(state.segments.length);
        state.smoothed = replayFeature.replayCurve(
          state.segments,
          (i) => state.segments[i]!.altitude_ft ?? 0,
          () => 1000,
          [none, none, lower],
        );
        map.jumpTo({ center: [8, 20], zoom: 11.5, pitch: 60 });

        callUpdateDisplay();

        expect(lift()).toBeCloseTo(
          liftOffsetPx(
            map as unknown as MapLibreMap,
            20,
            700,
            liftExaggeration(mockApp.reliefLevel),
          ),
          0,
        );
      });

      it("lifts it zoomed out too, where the replay starts", () => {
        // The replay's one flight is lifted at every zoom, unlike the flights
        map.jumpTo({ zoom: 8, pitch: 60 });

        callUpdateDisplay();

        expect(lift()).toBeGreaterThan(0);
      });

      it("points its popup at it, up where it is drawn", () => {
        map.jumpTo({ zoom: 13, pitch: 60 });
        airplane.openPopup();

        callUpdateDisplay();

        const offset = vi
          .mocked(airplane.popup.setOffset)
          .mock.calls.at(-1)![0] as Record<string, [number, number]>;
        // Opening above it or below it, the popup moves up with it
        expect(offset["bottom"]![1]).toBeCloseTo(-16 - lift(), 6);
        expect(offset["top"]![1]).toBeCloseTo(16 - lift(), 6);
      });

      it("keeps the lifted airplane, not the ground under it, in view", () => {
        // 3000 ft up at zoom 15, well over the top of an 800 px map, while
        // the ground under it is in the middle
        mockReplayManager.state.segments = [
          makeSegment({ time: 0, altitude_ft: 4000 }),
          makeSegment({ time: 0, altitude_ft: 4000 }),
          makeSegment({ time: 10, altitude_ft: 4000 }),
        ];
        mockReplayManager.state.currentTime = 5;
        mockReplayManager.state.playing = true;
        map.jumpTo({ center: [8.505, 50.005], zoom: 15, pitch: 60 });
        vi.mocked(map.jumpTo).mockClear();

        // Flat, the airplane is in the middle and nothing moves
        lifted(false);
        callUpdateDisplay();
        expect(map.jumpTo).not.toHaveBeenCalled();

        lifted(true);
        callUpdateDisplay();
        expect(map.jumpTo).toHaveBeenCalled();
        expect(map.easeTo).not.toHaveBeenCalled();
      });

      describe("far from the map", () => {
        /** The fake's projection, with the middle of the map in the middle */
        function centred(): void {
          map.project.mockReset();
          const project = map.project.getMockImplementation()!;
          const unproject = map.unproject.getMockImplementation()!;
          map.project.mockImplementation((lngLat) => {
            const p = project(lngLat);
            return new Point(p.x + 400, p.y + 300);
          });
          map.unproject.mockImplementation((point) => {
            const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
            return unproject([x - 400, y - 300]);
          });
        }

        /** Where the airplane is drawn on the screen, lifted */
        const drawn = (): { x: number; y: number } => {
          const [lat, lng] = airplane.position();
          const ground = map.project([lng, lat]);
          return { x: ground.x, y: ground.y - lift() };
        };

        beforeEach(() => {
          centred();
          mockReplayManager.state.playing = true;
        });

        it("jumps to the ground under the airplane, then up by its lift", () => {
          map.jumpTo({ center: [9.5, 51], zoom: 13, pitch: 60 });
          vi.mocked(map.jumpTo).mockClear();

          callUpdateDisplay();

          const [lat, lng] = airplane.position();
          const jumps = vi.mocked(map.jumpTo).mock.calls;
          expect(jumps[0]).toEqual([
            { center: [lng, lat] },
            mapHelpers.REPLAY_CAMERA_MOVE,
          ]);
          expect(jumps).toHaveLength(2);
          // Down the screen by its lift, which the tilt has room for: the
          // airplane is in the middle, to the lift at its new latitude
          expect(lift()).toBeLessThan(liftRoomPx(60, 36.87, 600));
          expect(drawn().x).toBeCloseTo(400, 6);
          expect(drawn().y).toBeCloseTo(300, 0);
        });

        it("brings an airplane above the camera no further than over its ground, and stays there", () => {
          // Far above the camera at this zoom and tilt
          mockReplayManager.state.segments = makeChain([90000, 90000, 90000]);
          lifted(true);
          map.jumpTo({ center: [9.5, 51], zoom: 15, pitch: 70 });

          callUpdateDisplay();

          const room = liftRoomPx(70, 36.87, 600);
          expect(lift()).toBeGreaterThan(room * 1.5);
          // The ground under the airplane is below the middle by the room
          // the tilt has, and the airplane above it by the rest of its lift
          const [lat, lng] = airplane.position();
          expect(map.project([lng, lat]).y).toBeCloseTo(300 + room, 6);
          const center = map.getCenter();

          // Frame after frame the camera jumps to the same place: it does
          // not run off after an airplane it cannot bring to the middle
          for (let frame = 0; frame < 5; frame++) {
            mockReplayManager.state.currentTime += 0.01;
            callUpdateDisplay();
          }
          expect(map.getCenter().lat).toBeCloseTo(center.lat, 3);
          expect(map.getCenter().lng).toBeCloseTo(center.lng, 3);
        });

        it("brings it back on a seek from anywhere", () => {
          mockReplayManager.state.playing = false;
          map.jumpTo({ center: [30, 20], zoom: 11.5, pitch: 50 });

          callUpdateDisplay(true);

          expect(drawn().x).toBeCloseTo(400, 6);
          expect(drawn().y).toBeCloseTo(300, 0);
        });
      });

      it("follows the map as it tilts under a paused airplane", () => {
        map.jumpTo({ zoom: 13, pitch: 30 });
        callUpdateDisplay();
        const at30 = lift();

        map.jumpTo({ zoom: 13, pitch: 60 });
        map.emit("move");

        expect(lift()).toBeGreaterThan(at30);
      });

      it("flies along the ribbon's curve through a turn, not across it", () => {
        // A right angle at the second point: the ribbon rounds it
        const segments = [0, 10, 20].map((time) =>
          makeSegment({ time, altitude_ft: 2000 }),
        );
        segments[0]!.coords = [
          [50, 8],
          [50.01, 8],
        ];
        segments[1]!.coords = [
          [50.01, 8],
          [50.01, 8.015],
        ];
        segments[2]!.coords = [
          [50.01, 8.015],
          [50.01, 8.03],
        ];
        mockReplayManager.state.segments = segments;
        lifted(true);
        // On the curve's times, as the replay puts them on its segments
        // (ReplayManager.initializeReplay)
        const { times } = mockReplayManager.state.smoothed!;
        segments.forEach((segment, i) => (segment.time = times[i]!));
        mockReplayManager.state.currentTime = times[1]! / 2;
        map.jumpTo({ zoom: 13, pitch: 60 });

        callUpdateDisplay();

        // Halfway through the time of the first segment, where its ribbon
        // is: the curve is off the straight line already, swinging out to
        // come into the turn
        const [lat, lon] = airplane.position();
        const onCurve = replayFeature.replayPoint(
          mockReplayManager.state.smoothed!,
          0,
          0.5,
        );
        expect(lat).toBeCloseTo(onCurve!.position[0], 9);
        expect(lon).toBeCloseTo(onCurve!.position[1], 9);
        expect(Math.abs(lon - 8)).toBeGreaterThan(1e-5);
        // Flat, on the same curve: the lines are drawn along it too
        mockReplayManager.state.lifted = false;
        callUpdateDisplay();
        expect(airplane.position()[1]).toBeCloseTo(lon, 9);
      });

      it("hands the trail to its line and the airplane to the ground zoomed in close", () => {
        const state = mockReplayManager.state;
        state.layerActive = true;
        const ribbons = (): unknown[] =>
          [
            MAP_SOURCES.replayTrailRibbons,
            MAP_SOURCES.replayTrailTipRibbons,
          ].flatMap(
            (id) =>
              (
                (map.source(id).data ?? { features: [] }) as {
                  features: unknown[];
                }
              ).features,
          );
        const lines = (): unknown[] =>
          ((trailSource().data ?? { features: [] }) as { features: unknown[] })
            .features;
        map.jumpTo({ zoom: 14, pitch: 60 });
        callUpdateDisplay(true);
        runFrame();
        expect(ribbons().length).toBeGreaterThan(0);
        expect(lift()).toBeGreaterThan(0);

        // Lower than a circuit, the camera would be among the flights
        map.jumpTo({ zoom: 17.5 });
        map.emit("move");
        runFrame();

        expect(ribbons()).toEqual([]);
        expect(lines().length).toBeGreaterThan(0);
        expect(lift()).toBe(0);
      });

      it("writes the runs of the trail behind the airplane as they change, and the one it is on in every frame", () => {
        const state = mockReplayManager.state;
        state.layerActive = true;
        // A colour of its own for each of the first segments
        state.segments = makeChain([1000, 3000, 5000, 7000, 7000, 7000]);
        state.segments.at(-1)!.groundspeed_knots = 0;
        lifted(true);
        state.maxTime = 60;
        map.jumpTo({ zoom: 13, pitch: 60 });
        const done = map.source(MAP_SOURCES.replayTrailRibbons);
        const tip = map.source(MAP_SOURCES.replayTrailTipRibbons);
        const colours = (source: typeof done): unknown[] => [
          ...new Set(
            (
              (source.data ?? { features: [] }) as {
                features: { properties: { color: string } }[];
              }
            ).features.map((feature) => feature.properties.color),
          ),
        ];
        const at = (time: number): void => {
          state.currentTime = time;
          callUpdateDisplay(true);
          runFrame();
        };

        at(35);
        const writes = done.setData.mock.calls.length;
        expect(colours(done)).toHaveLength(3);
        expect(colours(tip)).toHaveLength(1);
        expect(colours(done)).not.toContain(colours(tip)[0]);

        // On along the run of one colour, only the run it is on is written
        const tipWrites = tip.setData.mock.calls.length;
        at(45);
        at(48);
        expect(done.setData.mock.calls.length).toBe(writes);
        expect(tip.setData.mock.calls.length).toBe(tipWrites + 2);

        // Back into a run behind it, those behind it are written again
        renderer.removeSegmentsAfter(state, 15);
        at(15);
        expect(done.setData.mock.calls.length).toBe(writes + 1);
        expect(colours(done)).toHaveLength(1);
        expect(colours(tip)).toHaveLength(1);

        // And so they are for another relief level
        mockApp.reliefLevel = 12;
        at(16);
        expect(done.setData.mock.calls.length).toBe(writes + 2);
      });

      it("keeps a run it has just finished in the tip until the tiles of the runs behind show it", async () => {
        const state = mockReplayManager.state;
        state.layerActive = true;
        state.segments = makeChain([1000, 3000, 5000, 7000, 7000, 7000]);
        state.segments.at(-1)!.groundspeed_knots = 0;
        lifted(true);
        state.maxTime = 60;
        map.jumpTo({ zoom: 13, pitch: 60 });
        const done = map.source(MAP_SOURCES.replayTrailRibbons);
        const tip = map.source(MAP_SOURCES.replayTrailTipRibbons);
        const colours = (source: typeof done): number =>
          new Set(
            (
              (source.data ?? { features: [] }) as {
                features: { properties: { color: string } }[];
              }
            ).features.map((feature) => feature.properties.color),
          ).size;
        const at = (time: number): void => {
          state.currentTime = time;
          callUpdateDisplay(true);
          runFrame();
        };
        // Each write of the runs behind well apart from the last
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => (now += 1000));
        at(15);
        await Promise.resolve();
        await Promise.resolve();

        // Into the next colour: the worker has the runs behind, their tiles
        // are still being cut
        let landed!: () => void;
        done.setData.mockImplementationOnce((data: unknown) => {
          done.data = data;
          return new Promise<void>((resolve) => (landed = resolve));
        });
        map.isSourceLoaded.mockImplementation(
          (id: string) => id !== MAP_SOURCES.replayTrailRibbons,
        );
        at(25);
        const behind = colours(done);
        expect(colours(tip)).toBe(2);

        landed();
        await Promise.resolve();
        await Promise.resolve();
        at(26);
        expect(colours(tip)).toBe(2);

        // Once they are, the tip has the run the airplane is on alone
        map.isSourceLoaded.mockImplementation(() => true);
        map.emit("sourcedata", { sourceId: MAP_SOURCES.replayTrailRibbons });
        await Promise.resolve();
        await Promise.resolve();
        runFrame();
        expect(colours(tip)).toBe(1);
        expect(colours(done)).toBe(behind);
      });

      it("writes the runs behind it no more often than every 250 ms while they only grow", () => {
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const state = mockReplayManager.state;
        state.layerActive = true;
        state.segments = makeChain([1000, 3000, 5000, 7000, 7000, 7000]);
        state.segments.at(-1)!.groundspeed_knots = 0;
        lifted(true);
        state.maxTime = 60;
        map.jumpTo({ zoom: 13, pitch: 60 });
        const done = map.source(MAP_SOURCES.replayTrailRibbons);
        const tip = map.source(MAP_SOURCES.replayTrailTipRibbons);
        const colours = (source: typeof done): number =>
          new Set(
            (
              (source.data ?? { features: [] }) as {
                features: { properties: { color: string } }[];
              }
            ).features.map((feature) => feature.properties.color),
          ).size;
        const at = (time: number): void => {
          state.currentTime = time;
          callUpdateDisplay(true);
          runFrame();
        };
        now = 1000;
        at(15);
        const writes = done.setData.mock.calls.length;

        // Two more colours within the gap: the tip draws them meanwhile
        now = 1100;
        at(25);
        now = 1200;
        at(35);
        expect(done.setData.mock.calls.length).toBe(writes);
        expect(colours(tip)).toBe(3);

        // The first frame after it writes them, once
        now = 1260;
        at(36);
        expect(done.setData.mock.calls.length).toBe(writes + 1);
        expect(colours(done)).toBe(3);

        // A seek back is written at once, gap or not
        now = 1300;
        renderer.removeSegmentsAfter(state, 15);
        at(15);
        expect(done.setData.mock.calls.length).toBe(writes + 2);
      });

      it("keeps it on the ground while the trail is flat", () => {
        lifted(false);
        map.jumpTo({ zoom: 13, pitch: 60 });

        callUpdateDisplay();

        expect(lift()).toBe(0);
      });
    });

    describe("on a turned map", () => {
      let iconDiv: HTMLElement;

      beforeEach(() => {
        const airplane = makeAirplane();
        iconDiv = airplane
          .getElement()
          .querySelector<HTMLElement>(".replay-airplane-icon")!;
        mockReplayManager.state.airplaneMarker = airplane;
        mockReplayManager.state.currentTime = 5;
        // Due north
        mockReplayManager.state.segments = [
          makeSegment({
            time: 0,
            coords: [
              [50, 8.5],
              [50.01, 8.5],
            ],
          }),
        ];
      });

      const rotation = (): number =>
        Number(/rotate\((-?[\d.]+)deg\)/.exec(iconDiv.style.transform)![1]);

      it("points the icon along the track on screen, not over the ground", () => {
        map.jumpTo({ bearing: 90 });

        callUpdateDisplay();

        // Flying north on a map whose top is east: to the left
        expect(rotation()).toBeCloseTo(-90, 6);
        // What the readout says is still where the airplane flies
        expect(mockReplayManager.state.lastBearing).toBe(0);
      });

      it("turns the icon with the map while the replay is paused", () => {
        callUpdateDisplay();
        expect(rotation()).toBe(0);

        // No frame of the replay comes to say so: the map's own event does
        map.jumpTo({ bearing: 45 });
        map.emit("move");

        expect(rotation()).toBeCloseTo(-45, 6);
      });

      it("stops following the map when the replay closes", () => {
        callUpdateDisplay();
        expect(map.listenerCount("move")).toBe(1);
        callUpdateDisplay();
        expect(map.listenerCount("move")).toBe(1);

        renderer.camera.stopWatchingMap();

        expect(map.listenerCount("move")).toBe(0);
        map.jumpTo({ bearing: 45 });
        map.emit("move");
        expect(rotation()).toBe(0);
      });
    });

    it("starts the rotation afresh for the airplane of another replay", () => {
      const state = mockReplayManager.state;
      state.segments = [makeSegment({ time: 0 })];
      state.smoothed = replayFeature.replayCurve(state.segments, () => 0);
      const bearing = vi.spyOn(replayFeature, "replayPoint");
      const at = { position: [50, 8.5] as [number, number], heightFt: 0 };
      state.currentTime = 5;
      const first = makeAirplane();
      state.airplaneMarker = first;
      bearing.mockReturnValue({ ...at, track: 365, point: 0 });
      callUpdateDisplay();
      first.remove();

      // A replay starts with a stop, which the heading is taken at as it is
      state.lastBearing = null;
      const second = makeAirplane();
      state.airplaneMarker = second;
      bearing.mockReturnValue({ ...at, track: 10, point: 0 });
      callUpdateDisplay();

      expect(
        second.getElement().querySelector<HTMLElement>(".replay-airplane-icon")!
          .style.transform,
      ).toContain("rotate(10deg)");
    });

    it("keeps the last bearing where the flight stands still", () => {
      mockReplayManager.state.lastBearing = 90;
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({
          time: 0,
          coords: [
            [50, 8.5],
            [50, 8.5],
          ],
        }),
      ];

      callUpdateDisplay();

      expect(mockReplayManager.state.lastBearing).toBe(90);
    });

    it("follows when airplane is near viewport edge during playback", () => {
      airplaneAt(10, 10);

      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.project).toHaveBeenCalledWith([8.51, 50.01]);
      // A jump per frame: no animation that restarts on every frame
      expect(map.jumpTo).toHaveBeenCalledTimes(1);
      expect(map.easeTo).not.toHaveBeenCalled();
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(1);
    });

    it("ends the trail at the airplane in every frame", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.airplaneMarker = makeAirplane();
      state.segments = makeChain([0, 0, 10000]);
      state.smoothed = replayFeature.replayCurve(state.segments, () => 0);

      for (const time of [3, 7, 12, 18, 25]) {
        state.currentTime = time;
        callUpdateDisplay();
        runFrame();
        const { features } = trailSource().data as {
          features: { geometry: { coordinates: [number, number][] } }[];
        };
        const line = features[features.length - 1]!.geometry.coordinates;
        const [lat, lng] = state.airplaneMarker.position();
        expect(line[line.length - 1]).toEqual([lng, lat]);
      }
    });

    it("writes the trail in the frame the airplane moved in while playing", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.playing = true;
      state.airplaneMarker = makeAirplane();
      state.segments = makeChain([0, 0, 0]);
      state.smoothed = replayFeature.replayCurve(state.segments, () => 0);
      state.currentTime = 12;

      callUpdateDisplay();

      // No frame has run: the trail went to the map along with the airplane
      expect(trailSource().setData).toHaveBeenCalledTimes(1);
      runFrame();
      expect(trailSource().setData).toHaveBeenCalledTimes(1);
    });

    it("writes the trail once a frame while the slider is dragged during play", () => {
      const state = mockReplayManager.state;
      state.layerActive = true;
      state.playing = true;
      state.airplaneMarker = makeAirplane();
      state.segments = makeChain([0, 0, 0]);
      state.smoothed = replayFeature.replayCurve(state.segments, () => 0);

      // Input events of a drag, faster than frames: each wrote the whole
      // trail, and the frame wrote it again
      for (const time of [5, 12, 18]) {
        state.currentTime = time;
        callUpdateDisplay(true);
      }
      expect(trailSource().setData).not.toHaveBeenCalled();
      runFrame();
      expect(trailSource().setData).toHaveBeenCalledTimes(1);
    });

    it.each([1, 10, 100])(
      "turns the airplane through a turn a little in every frame at %sx",
      (speed) => {
        // A turn at 3 degrees a second, a fix every 2 s, 50 m/s
        const radius = 50 / ((3 * Math.PI) / 180);
        const points = Array.from({ length: 61 }, (_, i): [number, number] => {
          const angle = (i * 6 * Math.PI) / 180;
          return [
            50 + (radius * Math.sin(angle)) / 111320,
            8 +
              (radius * (1 - Math.cos(angle))) /
                (111320 * Math.cos((50 * Math.PI) / 180)),
          ];
        });
        const state = mockReplayManager.state;
        state.segments = points
          .slice(1)
          .map((end, i) =>
            makeSegment({ time: i * 2, coords: [points[i]!, end] }),
          );
        state.smoothed = replayFeature.replayCurve(state.segments, () => 0);
        state.airplaneMarker = makeAirplane();

        const headings: number[] = [];
        const tracks: number[] = [];
        // Twenty seconds of frames, or the whole turn
        const end = 4 + Math.min(96, 20 * speed);
        for (let time = 4; time < end; time += 0.016 * speed) {
          state.currentTime = time;
          callUpdateDisplay();
          headings.push(state.lastBearing!);
          const index = Math.floor(time / 2);
          tracks.push(
            replayFeature.replayPoint(state.smoothed, index, time / 2 - index)!
              .track!,
          );
        }
        const turned = (a: number, b: number): number =>
          Math.abs(((b - a + 540) % 360) - 180);
        // As far as the turn goes in the time of a frame, and a little
        const most = 3 * 0.016 * speed * 1.2 + 0.2;
        for (let i = 1; i < headings.length; i++) {
          expect(turned(headings[i - 1]!, headings[i]!)).toBeLessThan(most);
        }
        // Behind the curve by the damping only, never ahead of it
        headings.slice(10).forEach((heading, i) => {
          expect(turned(heading, tracks[i + 10]!)).toBeLessThan(2);
        });
      },
    );

    describe("following a replay at speed", () => {
      /**
       * A flight due east at 1000 km/h along 50 degrees north, and a map
       * whose middle is at its screen's middle (the fake's is at 0, 0)
       */
      function flyEast(): void {
        const state = mockReplayManager.state;
        state.segments = Array.from({ length: 500 }, (_, i) =>
          makeSegment({
            time: i,
            coords: [
              [50, 8 + i * 0.004],
              [50, 8 + (i + 1) * 0.004],
            ],
          }),
        );
        state.smoothed = replayFeature.replayCurve(state.segments, () => 0);
        state.airplaneMarker = makeAirplane();
        state.playing = true;
        // Back to the fake's own projection, moved to the middle
        map.project.mockReset();
        const project = map.project.getMockImplementation()!;
        const unproject = map.unproject.getMockImplementation()!;
        map.project.mockImplementation((lngLat) => {
          const p = project(lngLat);
          return new Point(p.x + 400, p.y + 300);
        });
        map.unproject.mockImplementation((point) => {
          const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
          return unproject([x - 400, y - 300]);
        });
        map.jumpTo({ center: [8, 50] });
      }

      /** Where the airplane is on the screen, and the camera, per frame */
      function play(frames: number, speed: number) {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const state = mockReplayManager.state;
        const seen: { x: number; camera: number }[] = [];
        for (let frame = 0; frame < frames; frame++) {
          state.currentTime += 0.016 * speed;
          callUpdateDisplay();
          const [lat, lng] = state.airplaneMarker!.position();
          seen.push({
            x: map.project([lng, lat]).x,
            camera: map.getCenter().lng,
          });
          vi.advanceTimersByTime(16);
        }
        return seen;
      }

      it("keeps the airplane on the map, and moves as steadily as it", () => {
        flyEast();
        // 100x: 44 km a second, 7 px per frame at this map's scale
        const seen = play(260, 100);

        for (const { x } of seen) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(800);
        }
        // Once it has caught up, the airplane is back in the middle, and
        // the camera steps about as far as it flies in every frame, the
        // steps changing smoothly: none of the stutter of a restarted pan
        expect(seen[seen.length - 1]!.x).toBeCloseTo(400, -1);
        const steps = seen
          .slice(200)
          .map((frame, i, all) => (all[i + 1]?.camera ?? NaN) - frame.camera)
          .filter((step) => !Number.isNaN(step));
        const flown = 0.016 * 100 * 0.004;
        steps.forEach((step, i) => {
          expect(Math.abs(step / flown - 1)).toBeLessThan(0.03);
          if (i > 0) {
            expect(Math.abs(step - steps[i - 1]!)).toBeLessThan(flown / 100);
          }
        });
        expect(map.easeTo).not.toHaveBeenCalled();
      });

      it("puts the airplane where it is once a frame, though the camera moves the map", () => {
        flyEast();
        // MapLibre fires a `move` from within every jump
        const jump = map.jumpTo.getMockImplementation()!;
        map.jumpTo.mockImplementation((options, eventData) => {
          const moved = jump(options, eventData);
          map.emit("move");
          return moved;
        });
        play(100, 100);
        const marker = mockReplayManager.state.airplaneMarker!;
        const placed = vi.spyOn(marker, "setLatLng");
        const lifted = vi.spyOn(marker, "setLift");
        const jumps = map.jumpTo.mock.calls.length;

        play(5, 100);

        expect(map.jumpTo.mock.calls.length).toBeGreaterThan(jumps);
        // Once by the frame, never back where the frame before left it,
        // and lifted and turned once, after the camera
        expect(placed).toHaveBeenCalledTimes(5);
        expect(lifted).toHaveBeenCalledTimes(5);
      });

      it("does not read a drag during a pause as the airplane's speed", () => {
        flyEast();
        const state = mockReplayManager.state;
        play(120, 100);
        // Paused, the map is dragged 300 px east of the airplane
        state.playing = false;
        vi.advanceTimersByTime(3000);
        const { lng } = map.getCenter();
        map.jumpTo({ center: [lng - 0.27, 50] });
        const before = map.getCenter().lng;

        state.playing = true;
        state.currentTime += 0.016 * 100;
        callUpdateDisplay();

        // The follow starts from rest: the frame before the pause is gone
        const flown = 0.016 * 100 * 0.004;
        expect(map.getCenter().lng - before).toBeLessThan(2.2 * flown);
      });

      it("speeds up and slows down without jumps", () => {
        flyEast();
        const seen = play(90, 100);
        const steps = seen
          .map((frame, i, all) => (all[i + 1]?.camera ?? NaN) - frame.camera)
          .filter((step) => !Number.isNaN(step));
        const flown = 0.016 * 100 * 0.004;
        // It picks up from rest, and never goes much faster than twice the
        // airplane, catching up with it, or changes its step by more than
        // a third of it
        for (let i = 1; i < steps.length; i++) {
          expect(steps[i]!).toBeGreaterThanOrEqual(0);
          expect(steps[i]!).toBeLessThan(2.2 * flown);
          expect(Math.abs(steps[i]! - steps[i - 1]!)).toBeLessThan(flown / 3);
        }
      });
    });

    it("does not pan while playing when the airplane is inside the margins", () => {
      airplaneAt(400, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.easeTo).not.toHaveBeenCalled();
      expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it("does not pan when paused and not seeking", () => {
      airplaneAt(10, 10);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = false;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(false);

      expect(map.easeTo).not.toHaveBeenCalled();
      expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it("leaves the camera alone while the map is zooming", () => {
      // A camera move ends the one before it, so a pan would stop the zoom
      airplaneAt(10, 10);
      map.isZooming.mockReturnValue(true);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.easeTo).not.toHaveBeenCalled();
      expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
    });

    describe("behind a globe", () => {
      // The end of the one segment, where the airplane is at this time
      const airplane = { lat: 50.01, lng: 8.51 };

      beforeEach(() => {
        map.setProjection({ type: "globe" });
        mockReplayManager.state.airplaneMarker = makeAirplane();
        mockReplayManager.state.playing = true;
        mockReplayManager.state.currentTime = 5;
        mockReplayManager.state.segments = [makeSegment({ time: 0 })];
        // Far from every edge of the 800 x 600 map, which is also where the
        // far side of a globe projects to
        airplaneAt(400, 300);
      });

      /** What the map says is drawn where the airplane projects to */
      function drawnThere(place: { lat: number; lng: number }): void {
        map.unproject.mockReturnValue(
          place as ReturnType<typeof map.unproject>,
        );
      }

      it("leaves the camera alone while the airplane is on the near side", () => {
        drawnThere(airplane);

        callUpdateDisplay();

        expect(map.easeTo).not.toHaveBeenCalled();
      });

      it("brings an airplane back that flew over the rim, though it never left the map", () => {
        // Another part of the world is drawn there: the airplane is behind it
        drawnThere({ lat: 50.01, lng: 151.49 });

        callUpdateDisplay();

        expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith(
          {
            center: [airplane.lng, airplane.lat],
          },
          mapHelpers.REPLAY_CAMERA_MOVE,
        );
      });

      it("zooms out for it at once when auto-zoom is on, like for one that left the map", () => {
        mockReplayManager.state.autoZoom = true;
        map.setZoom(12);
        drawnThere({ lat: 50.01, lng: 151.49 });

        callUpdateDisplay();

        expect(map.easeTo).toHaveBeenLastCalledWith(
          expect.objectContaining({ zoom: 11 }),
        );
      });

      it("jumps to it on a seek", () => {
        drawnThere({ lat: 50.01, lng: 151.49 });

        callUpdateDisplay(true);

        expect(map.jumpTo).toHaveBeenCalledWith(
          {
            center: [airplane.lng, airplane.lat],
          },
          mapHelpers.REPLAY_CAMERA_MOVE,
        );
      });
    });

    describe("while the user moves the map", () => {
      // A camera move resets every gesture: a pan per frame would end the
      // user's drag or pinch the moment it starts
      beforeEach(() => {
        airplaneAt(10, 10);
        mockReplayManager.state.airplaneMarker = makeAirplane();
        mockReplayManager.state.playing = true;
        mockReplayManager.state.currentTime = 5;
        mockReplayManager.state.segments = [makeSegment({ time: 0 })];
        // What the manager does as a replay opens
        renderer.camera.watchUser();
      });

      function expectCameraLeftAlone(): void {
        callUpdateDisplay();
        expect(map.easeTo).not.toHaveBeenCalled();
        expect(map.jumpTo).not.toHaveBeenCalled();
        expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
      }

      function expectCameraFollows(): void {
        callUpdateDisplay();
        expect(map.jumpTo).toHaveBeenCalledTimes(1);
      }

      it.each([
        ["mousedown", "mouseup"],
        ["touchstart", "touchend"],
        ["touchstart", "touchcancel"],
      ])("waits from %s to %s, before any move", (press, release) => {
        // Inside the click tolerance no handler is active yet
        map.getCanvasContainer().dispatchEvent(new Event(press));
        expectCameraLeftAlone();

        // Let go, wherever the pointer is by then
        window.dispatchEvent(new Event(release));
        expectCameraFollows();
      });

      it("sees a press that began before the first frame that would pan", () => {
        // No frame has run yet: the watching starts with the replay
        map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));

        expectCameraLeftAlone();
      });

      it("takes no other button for a press", () => {
        // The context menu of a right click swallows the mouseup on Linux
        // and macOS, and the camera would wait for it for good
        map
          .getCanvasContainer()
          .dispatchEvent(new MouseEvent("mousedown", { button: 2 }));

        expectCameraFollows();
      });

      it("takes no menu that opens for the end of a press", () => {
        // A long press on Android opens one with the finger still down; a
        // pan on every frame from then on would reset the drag under it
        map.getCanvasContainer().dispatchEvent(new Event("touchstart"));
        window.dispatchEvent(new Event("contextmenu"));

        expectCameraLeftAlone();
      });

      it("sees a release that went missing in the next move of the mouse", () => {
        // A menu that opens over a press takes the mouseup with it
        map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));
        window.dispatchEvent(new MouseEvent("mousemove", { buttons: 1 }));
        expectCameraLeftAlone();

        window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }));
        expectCameraFollows();
      });

      it("takes a camera move of the app for the end of a gesture it cut short", () => {
        // MapLibre resets the gesture handlers before every camera move,
        // and ends a drag or a pinch that way without a moveend
        map.isMoving.mockReturnValue(true);
        map.emit("movestart", { originalEvent: new Event("mousemove") });
        expectCameraLeftAlone();

        map.emit("movestart", {});

        expectCameraFollows();
      });

      it("keeps waiting while a finger of a pinch is still down", () => {
        map.getCanvasContainer().dispatchEvent(new Event("touchstart"));
        const lifted = Object.assign(new Event("touchend"), {
          touches: [{}],
        });
        window.dispatchEvent(lifted);

        expectCameraLeftAlone();
      });

      it.each(["movestart", "zoomstart"])(
        "waits from a %s of the user to the moveend, a key or a glide included",
        (start) => {
          map.isMoving.mockReturnValue(true);
          map.emit(start, { originalEvent: new Event("keydown") });
          expectCameraLeftAlone();

          // A camera move of the app that ends meanwhile says nothing
          // about the user's
          map.emit("moveend", {});
          expectCameraLeftAlone();

          map.emit("moveend", { originalEvent: new Event("keyup") });
          expectCameraFollows();
        },
      );

      it("takes a map at rest for the end of a move whose end went missing", () => {
        map.emit("movestart", { originalEvent: new Event("keydown") });
        map.isMoving.mockReturnValue(true);
        expectCameraLeftAlone();

        map.isMoving.mockReturnValue(false);
        expectCameraFollows();
      });

      it("does not wait for a camera move of the app", () => {
        map.emit("movestart", {});

        expectCameraFollows();
      });

      it.each(["rotatestart", "pitchstart"])(
        "leaves the compass to finish: waits from a %s of the app to its moveend",
        (start) => {
          // The compass turns the map with a camera move that carries no
          // DOM event, and a follow pan would end it in its first frame
          map.isMoving.mockReturnValue(true);
          map.emit("movestart", {});
          map.emit(start, {});
          expectCameraLeftAlone();
          expectCameraLeftAlone();

          map.emit("moveend", {});
          expectCameraFollows();
        },
      );

      it("takes a map at rest for the end of a turn whose end went missing", () => {
        map.isMoving.mockReturnValue(true);
        map.emit("rotatestart", {});
        expectCameraLeftAlone();

        map.isMoving.mockReturnValue(false);
        expectCameraFollows();
      });

      it("waits for the wheel, which moves nothing before the next frame", () => {
        map.scrollZoom.isActive.mockReturnValue(true);
        expectCameraLeftAlone();

        map.scrollZoom.isActive.mockReturnValue(false);
        expectCameraFollows();
      });

      it("listens once however often it is asked, and stops when the replay closes", () => {
        const types = [
          "movestart",
          "zoomstart",
          "rotatestart",
          "pitchstart",
          "moveend",
        ];
        renderer.camera.watchUser();
        for (const type of types) {
          expect(map.listenerCount(type)).toBe(1);
        }

        renderer.camera.stopWatchingMap();

        for (const type of types) {
          expect(map.listenerCount(type)).toBe(0);
        }
        map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));
        expectCameraFollows();
      });
    });

    it("uses binary search on manual seek with multiple segments", () => {
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.lastDrawnIndex = 5;
      mockReplayManager.state.currentIndex = 3;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
        makeSegment({ time: 20 }),
        makeSegment({ time: 30 }),
      ];
      vi.mocked(airplane.marker.setLngLat).mockClear();

      callUpdateDisplay(true);

      expect(mockReplayManager.state.currentIndex).toBe(1);
      expect(airplane.marker.setLngLat).toHaveBeenCalled();
    });

    it("does not recenter on manual seek while the airplane stays in view", () => {
      airplaneAt(400, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);

      expect(map.jumpTo).not.toHaveBeenCalled();
    });

    it("pans without animation on manual seek near the edge, throttled to 250 ms", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(10, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(1);
      expect(map.jumpTo).toHaveBeenCalledWith(
        { center: [8.51, 50.01] },
        mapHelpers.REPLAY_CAMERA_MOVE,
      );
      expect(map.easeTo).not.toHaveBeenCalled();

      // A second seek shortly after is throttled
      vi.advanceTimersByTime(SEEK_PAN_THROTTLE_MS - 50);
      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(1);

      // After the throttle window the map follows again
      vi.advanceTimersByTime(100);
      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(2);
      // Manual seeks do not feed the auto-zoom recenter counter
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(0);
    });

    it("tells the map it has come to rest once a frame passes without a pan, and not at every pan", () => {
      airplaneAt(10, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = vi.spyOn(performance, "now").mockReturnValue(1000);
      const rests = (): unknown[] => map.fire.mock.calls.map(([type]) => type);

      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledWith(
        expect.anything(),
        mapHelpers.REPLAY_CAMERA_MOVE,
      );
      // A frame with a pan in it is no rest
      runFrame();
      expect(rests()).toEqual([]);
      // The frame after it, without one, is
      runFrame();
      expect(rests()).toEqual(["moveend"]);
      expect(frames).toEqual([]);

      // Nor does it wait for good while the camera pans on and on
      for (let frame = 0; frame < 5; frame++) {
        now.mockReturnValue(2000 + frame * 300);
        vi.mocked(map.jumpTo).mockClear();
        mockReplayManager.state.lastSeekPanTime = 0;
        callUpdateDisplay(true);
        expect(map.jumpTo).toHaveBeenCalledOnce();
        runFrame();
      }
      expect(rests()).toEqual(["moveend", "moveend"]);
    });

    it("finds the airplane in the copy of the world the map looks at, past the antimeridian", () => {
      // The map has wrapped its centre back west of 180; the flight's
      // curve goes on past it
      map.jumpTo({ center: [-179.99, 50] });
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [
        makeSegment({
          time: 0,
          coords: [
            [50, 179.98],
            [50.01, 180.02],
          ],
        }),
      ];
      airplaneAt(400, 300);
      map.project.mockClear();
      vi.mocked(map.jumpTo).mockClear();

      callUpdateDisplay(true);

      // In the middle of the map there, not a world away: no jump
      expect(map.jumpTo).not.toHaveBeenCalled();
      const lngs = map.project.mock.calls.map(([at]) =>
        Array.isArray(at) ? (at as number[])[0]! : (at as { lng: number }).lng,
      );
      expect(lngs.length).toBeGreaterThan(0);
      for (const lng of lngs) expect(Math.abs(lng + 179.99)).toBeLessThan(1);
    });

    it("tells the map the camera has come to rest as the replay closes", () => {
      airplaneAt(10, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      renderer.camera.stopWatchingMap();

      expect(map.fire.mock.calls.map(([type]) => type)).toEqual(["moveend"]);
      // Once
      renderer.camera.stopWatchingMap();
      runFrame();
      expect(map.fire).toHaveBeenCalledOnce();
    });

    it("pans immediately on manual seek when the airplane left the viewport", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(10, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(1);

      // Outside the viewport: the throttle does not apply
      airplaneAt(-50, 300);
      vi.advanceTimersByTime(10);
      callUpdateDisplay(true);
      expect(map.jumpTo).toHaveBeenCalledTimes(2);
    });

    /** The zoom-outs among the camera moves; the pans carry no zoom */
    function zoomOuts(): { zoom: number }[] {
      return map.easeTo.mock.calls
        .map(([options]) => options as { zoom?: number })
        .filter((options): options is { zoom: number } => "zoom" in options);
    }

    it("auto-zooms out after frequent recenters", () => {
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(12);

      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 1000,
        now - 500,
        now - 100,
      ];

      callUpdateDisplay();

      // Onto the airplane: no pan runs while the map zooms
      expect(map.easeTo).toHaveBeenLastCalledWith({
        center: [8.51, 50.01],
        zoom: 11,
        duration: AUTO_ZOOM_DURATION_MS,
        animate: true,
      });
      expect(map.setZoom).not.toHaveBeenCalled();
      expect(mockReplayManager.state.recenterTimestamps).toEqual([]);
    });

    it("zooms out from the map's own zoom, which the user may have changed", () => {
      // Replay opened with auto-zoom at 15, then the user zoomed out to 12.5:
      // a remembered 15 made "zoom out" set 14
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(12.5);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [now - 900, now - 600];

      callUpdateDisplay();

      expect(zoomOuts()).toEqual([expect.objectContaining({ zoom: 11.5 })]);
    });

    it("counts one recenter per pan, not one per frame of it", () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(10, 10);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      // Twenty frames (320 ms) of the airplane near the edge while the pan
      // runs: the map follows on every frame, but it is one recenter and
      // no zoom. Counted per frame this fired a burst of zoom-outs.
      for (let frame = 0; frame < 20; frame++) {
        callUpdateDisplay();
        vi.advanceTimersByTime(16);
      }
      expect(map.jumpTo).toHaveBeenCalledTimes(20);
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(1);
      expect(zoomOuts()).toEqual([]);

      // Once a pan has had its time, still being at the edge is a new one
      vi.advanceTimersByTime(RECENTER_PAN_DURATION_MS);
      callUpdateDisplay();
      expect(mockReplayManager.state.recenterTimestamps).toHaveLength(2);
    });

    it("pans without animation for reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(12);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [now - 2000, now - 1000];

      callUpdateDisplay();

      // Straight to the airplane, and the zoom without its animation
      expect(map.jumpTo).toHaveBeenCalledExactlyOnceWith(
        {
          center: [8.51, 50.01],
        },
        mapHelpers.REPLAY_CAMERA_MOVE,
      );
      expect(map.easeTo).toHaveBeenCalledTimes(1);
      expect(map.easeTo.mock.calls[0]![0]).toMatchObject({ animate: false });
      expect(zoomOuts()).toEqual([expect.objectContaining({ zoom: 11 })]);
    });

    it("does not zoom out below the auto-zoom minimum", () => {
      // Map units: what was 9 under Leaflet
      expect(AUTO_ZOOM_MIN).toBe(8);
      airplaneAt(10, 10);
      map.getZoom.mockReturnValue(AUTO_ZOOM_MIN);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];
      const now = Date.now();
      mockReplayManager.state.recenterTimestamps = [
        now - 300,
        now - 200,
        now - 100,
      ];

      callUpdateDisplay();

      expect(zoomOuts()).toEqual([]);
    });

    it("stops at the auto-zoom minimum when the steps would pass it", () => {
      airplaneAt(400, -100_000);
      map.getZoom.mockReturnValue(AUTO_ZOOM_MIN + 1.5);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(zoomOuts()).toEqual([
        expect.objectContaining({ zoom: AUTO_ZOOM_MIN }),
      ]);
    });

    it("zooms out at once when the airplane has left the map", () => {
      // At 200x the pan fell behind at the follow zoom, and waiting for
      // three recenters left the airplane above the map for over a second
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      airplaneAt(400, -20);
      map.getZoom.mockReturnValue(15);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.autoZoom = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();
      expect(zoomOuts()).toEqual([expect.objectContaining({ zoom: 14 })]);

      // Still outside while that zoom has not settled: no second one
      map.getZoom.mockReturnValue(14);
      vi.advanceTimersByTime(AUTO_ZOOM_SETTLE_MS - 50);
      callUpdateDisplay();
      expect(zoomOuts()).toHaveLength(1);

      // Once it has, further out takes more than one level
      airplaneAt(400, -700);
      vi.advanceTimersByTime(50);
      callUpdateDisplay();
      expect(zoomOuts()).toHaveLength(2);
      expect(zoomOuts()[1]).toMatchObject({ center: [8.51, 50.01], zoom: 12 });
    });

    it("leaves the zoom alone off the map when auto-zoom is off", () => {
      airplaneAt(-50, 300);
      mockReplayManager.state.airplaneMarker = makeAirplane();
      mockReplayManager.state.playing = true;
      mockReplayManager.state.currentTime = 5;
      mockReplayManager.state.segments = [makeSegment({ time: 0 })];

      callUpdateDisplay();

      expect(map.jumpTo).toHaveBeenCalledTimes(1);
      expect(zoomOuts()).toEqual([]);
    });

    it("refreshes an open popup with the current segment index", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 15;
      const segments = [makeSegment({ time: 0 }), makeSegment({ time: 10 })];
      mockReplayManager.state.segments = segments;
      airplane.openPopup();

      callUpdateDisplay();

      expect(generateSegmentPopupHtml).toHaveBeenCalledWith(
        expect.objectContaining({ segment: segments[1] }),
      );
      expect(airplane.popup.setHTML).toHaveBeenCalledWith("<div>popup</div>");
      // The popup went along with the airplane
      expect(airplane.popup.getLngLat()).toMatchObject({
        lng: 8.51,
        lat: 50.01,
      });
    });

    it("rebuilds an open popup only when the airplane reaches another segment", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
      ];
      mockReplayManager.state.currentTime = 2;
      renderer.updateAirplanePopup(mockReplayManager.state);
      vi.mocked(generateSegmentPopupHtml).mockClear();

      mockReplayManager.state.currentTime = 4;
      callUpdateDisplay();
      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();

      mockReplayManager.state.currentTime = 12;
      callUpdateDisplay();
      expect(generateSegmentPopupHtml).toHaveBeenCalledTimes(1);
    });

    it("leaves a closed popup closed as the airplane moves on", () => {
      mockApp.replayActive = true;
      const airplane = makeAirplane();
      mockReplayManager.state.airplaneMarker = airplane;
      mockReplayManager.state.currentTime = 15;
      mockReplayManager.state.segments = [
        makeSegment({ time: 0 }),
        makeSegment({ time: 10 }),
      ];

      callUpdateDisplay();

      expect(airplane.isPopupOpen()).toBe(false);
      expect(generateSegmentPopupHtml).not.toHaveBeenCalled();
    });
  });
});
