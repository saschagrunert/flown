/**
 * Where the airport codes go around their dots, on the screen
 *
 * Every code is a chip on a stem from the ring of its dot (see
 * ui/airportLabels.ts). Each takes the first place where it covers no dot,
 * no other chip and no other stem, in the order of `ANGLES`, on the shortest
 * stem: above its dot first, then round it, the sides before the bottom.
 * Only where none of those is free does it go out further, on a longer stem
 * that says whose it is, and only then on a narrower chip. The home base
 * places first, then the busier airports. A code with nowhere to go is left
 * out until there is room again.
 *
 * Worked out on the screen from the dots as they are drawn, so it holds on
 * a turned, tilted or globe map and over the relief alike. While the map
 * moves a code keeps its place as long as that stays free, so the codes do
 * not wander with every frame; once it is at rest (`settle`) each takes the
 * best place free again, and a code pushed aside on the way goes back.
 *
 * A chip keeps off the square another airport's marker takes the pointer
 * in, not only off its dot: the markers are buttons, each over the ones
 * before it, and a chip under the edge of a later one's square gave its
 * clicks and its hover to that airport.
 *
 * On a tilted map a code is a pin: drawn as much smaller or larger as the
 * map draws its labels by their distance (`CodeItem.scale`), and standing
 * straight up from its dot, on a taller stem where it is crowded, before it
 * turns to any other angle (`CodeRoom.upright`).
 */

/** A code to place, its dot where it is on the screen */
export interface CodeItem {
  name: string;
  /** The middle of its dot, pixels of the map's container */
  x: number;
  y: number;
  /** The size of its chip, and the width of its narrower chip, in pixels */
  w: number;
  h: number;
  narrow: number;
  /**
   * How much smaller or larger the code is drawn, chip and stem: 1 on a map
   * seen from straight above, by its distance on a tilted one
   */
  scale?: number;
}

/** Where a code goes */
export interface CodePlace {
  /** Degrees clockwise from east, as the screen turns them */
  angle: number;
  /** Pixels from the middle of the dot to where the stem starts and ends */
  from: number;
  to: number;
  /** Pixels from the middle of the dot to the middle of the chip */
  at: number;
  /** Half the chip's size, in pixels */
  hw: number;
  hh: number;
  /** Whether it is the narrower chip */
  narrow: boolean;
  /** Which of the stems it is on (`CodeRoom.stems`), and its scale */
  level: number;
  scale: number;
}

/** A box of the screen, in pixels: left, top, right, bottom */
export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** What the codes are placed in */
export interface CodeRoom {
  /** The radius of a dot with its ring, in pixels */
  dot: number;
  /**
   * Half the square a marker takes the pointer in, in pixels: no chip goes
   * into another airport's. The dot's radius when left out.
   */
  target?: number;
  /**
   * The least a chip's pointer box is each way, in pixels: it may be its
   * airport's button, which is no smaller than that however small its face
   * is drawn. Its room is that box; the stem still ends at the face.
   */
  press?: number;
  /** Where a chip may go: the map, inside its edges */
  bounds: Box;
  /** What lies over the map and takes room from the codes: its panels */
  taken: readonly Box[];
  /**
   * What takes the pointer on the map besides the airports' markers (the
   * replay's airplane): a chip keeps off it, a stem may run under it
   */
  targets?: readonly Box[];
  /** The stem lengths to try, shortest first, in pixels */
  stems: readonly number[];
  /**
   * Whether the map is tilted, where a code is a pin: straight up from its
   * dot, on a taller stem before any other angle
   */
  upright?: boolean;
}

/**
 * The angles a code tries, in degrees clockwise from east: above its dot,
 * then round it a sixteenth at a time, right before left, the bottom last
 */
export const ANGLES: readonly number[] = [
  -90, -67.5, -112.5, -45, -135, -22.5, -157.5, 0, 180, 22.5, 157.5, 45, 135,
  67.5, 112.5, 90,
];

/** The angle of a code straight above its dot */
const UP = -90;

/**
 * On how many of the stems, shortest first, a pin tries straight up before
 * it turns to the other angles (`CodeRoom.upright`)
 */
const UPRIGHT_STEMS = 4;

/** Room kept between a chip and anything else, in pixels */
const GAP_PX = 2;

/**
 * Room kept between a chip on a longer stem and another airport's dot: its
 * stem says whose it is, but one right beside another dot still reads as
 * that airport's
 */
const FAR_GAP_PX = 6;

/**
 * How much further from the middle of a code on the shortest stem every
 * other dot is than its own: a code below one airport and above the next
 * is nobody's
 */
const OWN_DOT_MARGIN = 1.3;

/** Pixels across a cell of the grid the room is kept in */
const CELL_PX = 64;

/** Something that takes room: a dot, a chip, a stem, a panel or a target */
interface Taken {
  owner: string | null;
  kind: "dot" | "chip" | "stem" | "target";
  box: Box;
  /** A dot's middle and radius, a stem's ends */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The last look at the grid that found it (Grid.near) */
  seen: number;
}

/** A place a code may take, worked out */
interface Candidate {
  place: CodePlace;
  box: Box;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
}

/**
 * What is where, in cells, so a place is only checked against its own. A
 * look at it fills one list it keeps, and marks what it found rather than
 * gathering it in a set: a code with no room looks hundreds of times.
 */
class Grid {
  private readonly cells = new Map<number, Taken[]>();
  private readonly found: Taken[] = [];
  private look = 0;

  private static key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  add(taken: Taken): void {
    const { l, t, r, b } = taken.box;
    for (let x = Math.floor(l / CELL_PX); x <= Math.floor(r / CELL_PX); x++) {
      for (let y = Math.floor(t / CELL_PX); y <= Math.floor(b / CELL_PX); y++) {
        const key = Grid.key(x, y);
        const cell = this.cells.get(key);
        if (cell) cell.push(taken);
        else this.cells.set(key, [taken]);
      }
    }
  }

  /**
   * Everything in the cells the box touches, once each, in a list that is
   * the grid's own until its next look
   */
  near(l: number, t: number, r: number, b: number): readonly Taken[] {
    const look = ++this.look;
    const found = this.found;
    found.length = 0;
    for (let x = Math.floor(l / CELL_PX); x <= Math.floor(r / CELL_PX); x++) {
      for (let y = Math.floor(t / CELL_PX); y <= Math.floor(b / CELL_PX); y++) {
        const cell = this.cells.get(Grid.key(x, y));
        if (!cell) continue;
        for (const taken of cell) {
          if (taken.seen === look) continue;
          taken.seen = look;
          found.push(taken);
        }
      }
    }
    return found;
  }
}

function overlaps(a: Box, b: Box, gap: number): boolean {
  return (
    a.l < b.r + gap && a.r > b.l - gap && a.t < b.b + gap && a.b > b.t - gap
  );
}

/** How far a point is from a box, 0 inside it */
function boxDistance(box: Box, x: number, y: number): number {
  const dx = Math.max(box.l - x, 0, x - box.r);
  const dy = Math.max(box.t - y, 0, y - box.b);
  return Math.hypot(dx, dy);
}

/** How far a point is from a line between two points */
function lineDistance(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length));
  return Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
}

/** Which side of the line from 1 to 2 a point is on */
function side(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
  y: number,
): number {
  return Math.sign((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1));
}

/** Whether two lines cross */
function cross(a: Candidate | Taken, b: Taken): boolean {
  return (
    side(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1) *
      side(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2) <
      0 &&
    side(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1) *
      side(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2) <
      0
  );
}

/** Whether a line runs through a box (Liang-Barsky clipping) */
function lineInBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  box: Box,
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  clipped[0] = 0;
  clipped[1] = 1;
  return (
    clip(-dx, x1 - box.l) &&
    clip(dx, box.r - x1) &&
    clip(-dy, y1 - box.t) &&
    clip(dy, box.b - y1)
  );
}

/** The part of a line still inside the edges clipped so far (lineInBox) */
const clipped = [0, 1];

/** Clip a line at one edge: whether any of it is still inside */
function clip(p: number, q: number): boolean {
  if (p === 0) return q >= 0;
  const t = q / p;
  if (p < 0) clipped[0] = Math.max(clipped[0]!, t);
  else clipped[1] = Math.min(clipped[1]!, t);
  return clipped[0]! <= clipped[1]!;
}

/**
 * The place of a code at an angle, on one of the stems, on its full or its
 * narrower chip, all of it at the code's scale
 */
function candidate(
  item: CodeItem,
  angle: number,
  room: CodeRoom,
  level: number,
  narrow: boolean,
): Candidate {
  const radians = (angle * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const scale = item.scale ?? 1;
  const stem = room.stems[level]! * scale;
  const dot = room.dot;
  const hw = ((narrow ? item.narrow : item.w) * scale) / 2;
  const hh = (item.h * scale) / 2;
  // From the middle of the chip to its edge, towards the dot
  const edge = Math.min(
    Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity,
  );
  const from = dot;
  const to = dot + stem;
  const at = to + edge;
  const cx = item.x + at * ux;
  const cy = item.y + at * uy;
  const press = (room.press ?? 0) / 2;
  const pw = Math.max(hw, press);
  const ph = Math.max(hh, press);
  return {
    place: { angle, from, to, at, hw, hh, narrow, level, scale },
    box: { l: cx - pw, t: cy - ph, r: cx + pw, b: cy + ph },
    x1: item.x + from * ux,
    y1: item.y + from * uy,
    x2: item.x + to * ux,
    y2: item.y + to * uy,
    cx,
    cy,
  };
}

/** What a place is: free, taken, or free but for a stem it crosses */
const FREE = 0;
const TAKEN = 1;
const CROSSING = 2;
type Fit = typeof FREE | typeof TAKEN | typeof CROSSING;

/**
 * Whether a place is free: inside the map, clear of the panels, of every
 * other dot and the square its marker takes the pointer in, of every chip
 * and stem, and its stem clear of them too. On the shortest stem the chip
 * has to be clearly nearer its own dot than any other; further out the
 * stem says whose it is, and it only has to keep off the others. A place
 * whose stem would only cross another's is `CROSSING`, which a code takes
 * when nothing else is free.
 */
function fit(
  item: CodeItem,
  c: Candidate,
  room: CodeRoom,
  grid: Grid,
  short: boolean,
): Fit {
  const { box } = c;
  const { bounds } = room;
  if (box.l < bounds.l || box.t < bounds.t) return TAKEN;
  if (box.r > bounds.r || box.b > bounds.b) return TAKEN;
  const target = room.target ?? room.dot;
  const own = Math.hypot(c.cx - item.x, c.cy - item.y) * OWN_DOT_MARGIN;
  const reach = Math.max(FAR_GAP_PX + room.dot, target, short ? own : 0);
  const near = grid.near(
    Math.min(box.l, c.x1) - reach,
    Math.min(box.t, c.y1) - reach,
    Math.max(box.r, c.x1) + reach,
    Math.max(box.b, c.y1) + reach,
  );
  let crossing = false;
  for (const taken of near) {
    if (taken.owner === item.name) continue;
    if (taken.kind === "dot") {
      const { x1: x, y1: y, x2: r } = taken;
      const gap = short ? GAP_PX : FAR_GAP_PX;
      if (boxDistance(box, x, y) < r + gap) return TAKEN;
      // The other marker's square, which would take this chip's clicks
      if (
        box.l < x + target &&
        box.r > x - target &&
        box.t < y + target &&
        box.b > y - target
      ) {
        return TAKEN;
      }
      if (lineDistance(x, y, c.x1, c.y1, c.x2, c.y2) < r + 1) return TAKEN;
      if (short && Math.hypot(c.cx - x, c.cy - y) < own) return TAKEN;
    } else if (taken.kind === "chip") {
      if (overlaps(box, taken.box, GAP_PX)) return TAKEN;
      if (lineInBox(c.x1, c.y1, c.x2, c.y2, taken.box)) return TAKEN;
    } else if (taken.kind === "target") {
      if (overlaps(box, taken.box, GAP_PX)) return TAKEN;
    } else {
      if (lineInBox(taken.x1, taken.y1, taken.x2, taken.y2, box)) return TAKEN;
      crossing ||= cross(c, taken);
    }
  }
  return crossing ? CROSSING : FREE;
}

/** How many codes have a place */
function count(places: ReadonlyMap<string, CodePlace | null>): number {
  let placed = 0;
  for (const place of places.values()) if (place) placed++;
  return placed;
}

/**
 * How many codes left out at rest may have a second chance ahead of the
 * others. Each costs a whole second placing of every code, and where many
 * are left out the map is too crowded for that to win much.
 */
const SECOND_CHANCES = 8;

/**
 * Place the codes: for each, where it goes, or null for none. At rest, a
 * few codes left out get a second chance ahead of the others, which may
 * well find places of their own around them: whichever leaves out fewer is
 * taken.
 * @param items - The codes, the first placed first
 * @param previous - Where each was before; kept while it is free, unless
 *   `settle`
 * @param retry - Which codes that had no place before look for one again:
 *   all, none, or those named
 */
export function placeCodes(
  items: readonly CodeItem[],
  room: CodeRoom,
  previous: ReadonlyMap<string, CodePlace | null>,
  settle: boolean,
  retry: boolean | ReadonlySet<string> = settle,
): Map<string, CodePlace | null> {
  let best = placeInOrder(items, room, previous, settle, retry);
  if (!settle) return best;
  const out = items.filter((item) => !best.get(item.name));
  if (out.length === 0 || out.length > SECOND_CHANCES) return best;
  const ahead = new Set(out);
  const again = placeInOrder(
    [...out, ...items.filter((item) => !ahead.has(item))],
    room,
    previous,
    settle,
    retry,
  );
  if (count(again) > count(best)) best = again;
  return best;
}

function placeInOrder(
  items: readonly CodeItem[],
  room: CodeRoom,
  previous: ReadonlyMap<string, CodePlace | null>,
  settle: boolean,
  retry: boolean | ReadonlySet<string>,
): Map<string, CodePlace | null> {
  const grid = new Grid();
  const r = room.dot;
  const order = tries(room);
  for (const item of items) {
    grid.add({
      owner: item.name,
      kind: "dot",
      box: { l: item.x - r, t: item.y - r, r: item.x + r, b: item.y + r },
      x1: item.x,
      y1: item.y,
      x2: r,
      y2: 0,
      seen: 0,
    });
  }
  for (const [kind, boxes] of [
    ["chip", room.taken],
    ["target", room.targets ?? []],
  ] as const) {
    for (const box of boxes) {
      grid.add({
        owner: null,
        kind,
        box,
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        seen: 0,
      });
    }
  }

  const placed = new Map<string, CodePlace | null>();
  const take = (item: CodeItem, c: Candidate): void => {
    placed.set(item.name, c.place);
    const { x1, y1, x2, y2 } = c;
    grid.add({
      owner: item.name,
      kind: "chip",
      box: c.box,
      x1,
      y1,
      x2,
      y2,
      seen: 0,
    });
    const stem = {
      l: Math.min(x1, x2),
      t: Math.min(y1, y2),
      r: Math.max(x1, x2),
      b: Math.max(y1, y2),
    };
    grid.add({
      owner: item.name,
      kind: "stem",
      box: stem,
      x1,
      y1,
      x2,
      y2,
      seen: 0,
    });
  };

  for (const item of items) {
    const before = previous.get(item.name);
    if (!settle && before && before.level < room.stems.length) {
      const c = candidate(
        item,
        before.angle,
        room,
        before.level,
        before.narrow,
      );
      if (fit(item, c, room, grid, before.level === 0) !== TAKEN) {
        take(item, c);
        continue;
      }
    }
    const looks = retry === true || (retry !== false && retry.has(item.name));
    if (before === null && !looks) {
      placed.set(item.name, null);
      continue;
    }
    const found = search(item, room, grid, order);
    if (found) take(item, found);
    else placed.set(item.name, null);
  }
  return placed;
}

/**
 * The places a code tries, in order, as `[level, angle]`: the shortest stem
 * first, the angles in their order; on a tilted map straight up on the
 * first few stems before that, as a pin on a taller pole
 */
export function tries(room: CodeRoom): readonly (readonly [number, number])[] {
  const order: [number, number][] = [];
  const upright = room.upright ? Math.min(UPRIGHT_STEMS, room.stems.length) : 0;
  for (let level = 0; level < upright; level++) order.push([level, UP]);
  for (let level = 0; level < room.stems.length; level++) {
    for (const angle of ANGLES) {
      if (angle !== UP || level >= upright) order.push([level, angle]);
    }
  }
  return order;
}

/**
 * The first free place of a code, in the order it tries them (`tries`), the
 * full chip before the narrower one. Only where none is free does it take
 * the first whose stem merely crosses another.
 */
function search(
  item: CodeItem,
  room: CodeRoom,
  grid: Grid,
  order: readonly (readonly [number, number])[],
): Candidate | null {
  let crossing: Candidate | null = null;
  for (const narrow of [false, true]) {
    if (narrow && item.narrow >= item.w) break;
    for (const [level, angle] of order) {
      const c = candidate(item, angle, room, level, narrow);
      const fits = fit(item, c, room, grid, level === 0);
      if (fits === FREE) return c;
      if (fits === CROSSING) crossing ??= c;
    }
  }
  return crossing;
}
