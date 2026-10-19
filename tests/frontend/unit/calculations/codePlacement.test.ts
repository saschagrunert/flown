import { describe, it, expect } from "vitest";
import {
  ANGLES,
  placeCodes,
  tries,
  type CodeItem,
  type CodePlace,
  type CodeRoom,
} from "../../../../flown/frontend/calculations/codePlacement";

/** A code of 40 by 16 pixels at a dot */
function item(name: string, x: number, y: number): CodeItem {
  return { name, x, y, w: 40, h: 16, narrow: 36 };
}

const room: CodeRoom = {
  dot: 4,
  bounds: { l: 0, t: 0, r: 1000, b: 1000 },
  taken: [],
  stems: [5, 14, 26, 42],
};

/** The box of a placed code, as the screen has it */
function boxOf(code: CodeItem, place: CodePlace) {
  const radians = (place.angle * Math.PI) / 180;
  const x = code.x + place.at * Math.cos(radians);
  const y = code.y + place.at * Math.sin(radians);
  return {
    l: x - place.hw,
    t: y - place.hh,
    r: x + place.hw,
    b: y + place.hh,
  };
}

function overlap(a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

describe("placeCodes", () => {
  it("puts a code with room above its dot, on the shortest stem", () => {
    const places = placeCodes([item("A", 500, 500)], room, new Map(), true);
    const place = places.get("A")!;

    expect(place.angle).toBe(-90);
    expect(place.from).toBe(4);
    expect(place.to).toBe(9);
    // Its middle half its height past the end of the stem
    expect(place.at).toBeCloseTo(17);
    expect(place.narrow).toBe(false);
  });

  it("tries above, then round the dot, the sides before the bottom", () => {
    expect(ANGLES[0]).toBe(-90);
    expect(ANGLES.at(-1)).toBe(90);
    expect(new Set(ANGLES).size).toBe(16);
    expect(ANGLES.indexOf(0)).toBeLessThan(ANGLES.indexOf(90));
    expect(ANGLES.indexOf(180)).toBeLessThan(ANGLES.indexOf(90));
  });

  it("places the first code first: a later one goes round it", () => {
    // B's dot sits right where A's code would go above it, so A goes
    // elsewhere; first, B is above its own dot
    const a = item("A", 500, 500);
    const b = item("B", 500, 478);
    const places = placeCodes([b, a], room, new Map(), true);

    expect(places.get("B")!.angle).toBe(-90);
    const placeA = places.get("A")!;
    expect(placeA.angle).not.toBe(-90);
    expect(overlap(boxOf(a, placeA), boxOf(b, places.get("B")!))).toBe(false);
  });

  it("never puts two codes over one another, nor over another dot", () => {
    const items = Array.from({ length: 40 }, (_, i) =>
      item(`C${i}`, 300 + (i % 8) * 37, 300 + Math.floor(i / 8) * 29),
    );
    const places = placeCodes(items, room, new Map(), true);
    const shown = items.filter((code) => places.get(code.name));

    expect(shown.length).toBeGreaterThan(20);
    for (const [i, a] of shown.entries()) {
      const box = boxOf(a, places.get(a.name)!);
      for (const b of shown.slice(i + 1)) {
        expect(overlap(box, boxOf(b, places.get(b.name)!))).toBe(false);
      }
      for (const other of items) {
        if (other === a) continue;
        const dx = Math.max(box.l - other.x, 0, other.x - box.r);
        const dy = Math.max(box.t - other.y, 0, other.y - box.b);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(room.dot);
      }
    }
  });

  it("goes out on a longer stem only where no short one is free", () => {
    // Dots all round A at the reach of a short stem, between the angles
    // its stems go out at
    const a = item("A", 500, 500);
    const ring = Array.from({ length: 8 }, (_, i) => {
      const radians = ((22.5 + i * 45) * Math.PI) / 180;
      return item(
        `R${i}`,
        500 + 24 * Math.cos(radians),
        500 + 24 * Math.sin(radians),
      );
    });
    const places = placeCodes([a, ...ring], room, new Map(), true);
    const place = places.get("A")!;

    expect(place.to - place.from).toBeGreaterThan(room.stems[0]!);
  });

  it("keeps a chip out of the square another marker takes the pointer in", () => {
    // B's dot is far enough off the chip above A, but the square round it,
    // where B's button takes a press, reaches into it
    const a = item("A", 500, 500);
    const b = item("B", 530, 470);

    const byDot = placeCodes([b, a], room, new Map(), true).get("A")!;
    expect(byDot.angle).toBe(-90);

    const places = placeCodes([b, a], { ...room, target: 12 }, new Map(), true);
    const box = boxOf(a, places.get("A")!);
    const square = { l: b.x - 12, t: b.y - 12, r: b.x + 12, b: b.y + 12 };
    expect(places.get("A")!.angle).not.toBe(-90);
    expect(overlap(box, square)).toBe(false);
  });

  it("gives a chip room for a finger's press round its face, the stem ending at the face", () => {
    // The faces are 16 pixels high: as faces they would fit one over the
    // other here, but each may be its airport's button, 24 pixels high
    const a = item("A", 500, 500);
    const b = item("B", 500, 522);
    const pressed = { ...room, press: 24 };
    const places = placeCodes([a, b], pressed, new Map(), true);
    const press = (code: CodeItem, place: CodePlace) => {
      const face = boxOf(code, place);
      const x = (face.l + face.r) / 2;
      const y = (face.t + face.b) / 2;
      return { l: x - place.hw, t: y - 12, r: x + place.hw, b: y + 12 };
    };
    const pa = press(a, places.get("A")!);
    const pb = press(b, places.get("B")!);
    expect(overlap(pa, pb)).toBe(false);

    // Its stem still ends at its face: half the face's height past it
    const lone = placeCodes([a], pressed, new Map(), true).get("A")!;
    expect(lone.hh).toBe(8);
    expect(lone.at - lone.to).toBeCloseTo(8);
  });

  it("keeps a code on the shortest stem nearer its own dot than any other", () => {
    // Below A and above B is nobody's: B's dot is as near as A's
    const a = item("A", 500, 500);
    const b = item("B", 500, 540);
    const blockAbove = item("X", 500, 470);
    const places = placeCodes(
      [blockAbove, b, a],
      { ...room, stems: [5] },
      new Map(),
      true,
    );
    const place = places.get("A");

    expect(place?.angle).not.toBe(90);
  });

  it("leaves a code out where nothing is free, and keeps the map's edges", () => {
    const tight = { ...room, bounds: { l: 0, t: 0, r: 30, b: 30 } };

    expect(
      placeCodes([item("A", 15, 15)], tight, new Map(), true).get("A"),
    ).toBeNull();
  });

  it("keeps clear of what lies over the map", () => {
    const places = placeCodes(
      [item("A", 500, 500)],
      { ...room, taken: [{ l: 400, t: 400, r: 600, b: 496 }] },
      new Map(),
      true,
    );

    expect(places.get("A")!.angle).not.toBe(-90);
  });

  it("keeps a chip off another marker's square, its stem may run under it", () => {
    // Replay's airplane right over the dot: the code goes past it, on a
    // longer stem, rather than under it
    const target = { l: 488, t: 460, r: 512, b: 512 };
    const places = placeCodes(
      [item("A", 500, 500)],
      { ...room, targets: [target] },
      new Map(),
      true,
    );
    const place = places.get("A")!;

    expect(place).not.toBeNull();
    expect(overlap(boxOf(item("A", 500, 500), place), target)).toBe(false);
    // As a panel there would take its stem's room as well
    expect(
      placeCodes(
        [item("A", 500, 500)],
        { ...room, taken: [target] },
        new Map(),
        true,
      ).get("A"),
    ).not.toEqual(place);
  });

  it("works on the screen as it is, a turned map's alike", () => {
    // The same two airports, one above the other, or side by side as a
    // quarter turn leaves them
    const upright = placeCodes(
      [item("B", 500, 478), item("A", 500, 500)],
      room,
      new Map(),
      true,
    );
    const turned = placeCodes(
      [item("B", 456, 500), item("A", 500, 500)],
      room,
      new Map(),
      true,
    );

    expect(upright.get("A")!.angle).not.toBe(-90);
    expect(turned.get("A")!.angle).toBe(-90);
  });

  describe("while the map moves", () => {
    const blocked = item("B", 500, 478);

    it("keeps a code where it was while that is free, and only at rest takes the best place again", () => {
      const a = item("A", 500, 500);
      // Pushed aside by B, which then went
      const aside = placeCodes([blocked, a], room, new Map(), true);
      const before = aside.get("A")!;
      expect(before.angle).not.toBe(-90);

      const moving = placeCodes([a], room, aside, false);
      expect(moving.get("A")).toEqual(before);

      const rest = placeCodes([a], room, moving, true);
      expect(rest.get("A")!.angle).toBe(-90);
    });

    it("moves a code whose place was taken", () => {
      const a = item("A", 500, 500);
      const free = placeCodes([a], room, new Map(), true);

      const moving = placeCodes([blocked, a], room, free, false);

      expect(moving.get("A")!.angle).not.toBe(-90);
    });

    it("looks for a place for a code left out only when asked to", () => {
      const a = item("A", 500, 500);
      const out = new Map<string, CodePlace | null>([["A", null]]);

      expect(placeCodes([a], room, out, false, false).get("A")).toBeNull();
      expect(placeCodes([a], room, out, false, true).get("A")).not.toBeNull();
      // Only those named look, as in a frame of a move
      const both = new Map<string, CodePlace | null>([
        ["A", null],
        ["C", null],
      ]);
      const c = item("C", 200, 200);
      const named = placeCodes([a, c], room, both, false, new Set(["C"]));
      expect(named.get("A")).toBeNull();
      expect(named.get("C")).not.toBeNull();
      // One the map has not had before always looks
      expect(placeCodes([a], room, new Map(), false, false).get("A")).not.toBe(
        null,
      );
    });
  });

  it("takes a narrower chip only where the full one has no place", () => {
    const a = { ...item("A", 20, 500), w: 60, narrow: 40 };
    // Room to the right of the map's edge for a narrow chip alone, and none
    // above, below or to the left
    const places = placeCodes(
      [a],
      {
        ...room,
        bounds: { l: 0, t: 485, r: 80, b: 515 },
        stems: [5],
      },
      new Map(),
      true,
    );

    expect(places.get("A")?.narrow).toBe(true);
  });

  it("gives a code left out a second chance ahead of the others at rest", () => {
    // A ring of codes round a dot leaves the one placed last no room; ahead
    // of them it finds one, and they find their own round it
    const items = Array.from({ length: 9 }, (_, i) =>
      item(`C${i}`, 500 + (i % 3) * 30, 500 + Math.floor(i / 3) * 22),
    );
    const once = placeCodes(
      items,
      { ...room, stems: [5, 14] },
      new Map(),
      false,
    );
    const twice = placeCodes(
      items,
      { ...room, stems: [5, 14] },
      new Map(),
      true,
    );
    const placed = (map: Map<string, CodePlace | null>) =>
      [...map.values()].filter(Boolean).length;

    expect(placed(twice)).toBeGreaterThanOrEqual(placed(once));
  });

  it("places a hundred codes well within a frame", () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      item(`C${i}`, 40 + ((i * 97) % 900), 40 + ((i * 53) % 900)),
    );
    const settled = placeCodes(items, room, new Map(), true);
    // The fastest of the frames: a busy runner or a collection now and then
    // makes the mean miss by a little, a placement that grew out of hand
    // misses in every frame
    let fastest = Infinity;
    for (let frame = 0; frame < 20; frame++) {
      const start = performance.now();
      placeCodes(items, room, settled, false);
      fastest = Math.min(fastest, performance.now() - start);
    }

    expect(fastest).toBeLessThan(5);
  });

  it("on a tilted map tries straight up on the first stems before turning", () => {
    const order = tries({ ...room, upright: true });
    expect(order.slice(0, 4)).toEqual([
      [0, -90],
      [1, -90],
      [2, -90],
      [3, -90],
    ]);
    // Every place once, the others as on a flat map
    expect(order).toHaveLength(room.stems.length * ANGLES.length);
    expect(new Set(order.map(([l, a]) => `${l}/${a}`)).size).toBe(order.length);
    expect(order[4]).toEqual([0, ANGLES[1]]);
    expect(tries(room)[0]).toEqual([0, -90]);
    expect(tries(room)[1]).toEqual([0, ANGLES[1]]);
  });

  it("stands a crowded pin up on a taller stem rather than beside its dot", () => {
    // B's code beside A's place above takes it, but not the room higher up
    const a = item("A", 500, 500);
    const b = item("B", 530, 490);
    const flat = placeCodes([b, a], room, new Map(), true).get("A")!;
    const pin = placeCodes(
      [b, a],
      { ...room, upright: true },
      new Map(),
      true,
    ).get("A")!;

    expect(flat.angle).not.toBe(-90);
    expect(pin.angle).toBe(-90);
    expect(pin.level).toBeGreaterThan(0);
  });

  it("draws a code at its scale, chip and stem", () => {
    const code = { ...item("A", 500, 500), scale: 0.8 };
    const place = placeCodes([code], room, new Map(), true).get("A")!;

    expect(place.scale).toBe(0.8);
    expect(place.hw).toBeCloseTo(16);
    expect(place.hh).toBeCloseTo(6.4);
    expect(place.to - place.from).toBeCloseTo(4);
  });

  it("keeps a code on its stem while the map moves, at its scale now", () => {
    const code = item("A", 500, 500);
    const before = placeCodes([code], room, new Map(), true);
    const after = placeCodes(
      [{ ...code, scale: 1.1 }],
      room,
      before,
      false,
    ).get("A")!;
    expect(after.level).toBe(0);
    expect(after.scale).toBe(1.1);
    expect(after.hw).toBeCloseTo(22);
  });
});
