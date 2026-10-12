/**
 * The look of the heat cloud (ui/heatCloudLayer.ts): the constants it is
 * tuned by, what they make of a zoom, and the shaders that draw it, with
 * the attributes and uniforms they read.
 */
import { CLOUD_POINT_FLOATS } from "../calculations/heatCloud";

/**
 * By map zoom: the blur of a stretch at the middle of the map, in CSS
 * pixels (the standard deviation of the Gaussian), and how much of its heat
 * it glows with (see CLOUD_REFERENCE_SPEED_MS), between the stops linearly.
 * Out to 9.5 (the app's 10.5) the glow reaches 21 px, as the heatmap's
 * points reach 18 over a country, and a region's routes run together into
 * a cloud, which its height and its shadow set apart. Closer
 * in a glow that wide over every track of a busy field covered its roads
 * and labels, where the flat heatmap narrows its reach and then hands over
 * to thin heat lines (HEAT_LINES): it narrows to a crisp glow along each
 * track, and dims so
 * that only the tracks flown over and over glow white, the circuit of the
 * home field among them.
 */
export const CLOUD_STOPS: readonly (readonly [
  zoom: number,
  sigmaPx: number,
  gain: number,
])[] = [
  [9.5, 7, 1],
  [10.5, 4.5, 0.75],
  [13, 2.5, 0.5],
];

/** The blur and the gain of CLOUD_STOPS at the map zoom `zoom` */
export function cloudLook(zoom: number): { sigmaPx: number; gain: number } {
  const next = CLOUD_STOPS.findIndex(([stop]) => stop > zoom);
  if (next <= 0) {
    const [, s, g] =
      next === 0 ? CLOUD_STOPS[0]! : CLOUD_STOPS[CLOUD_STOPS.length - 1]!;
    return { sigmaPx: s, gain: g };
  }
  const [z0, s0, g0] = CLOUD_STOPS[next - 1]!;
  const [z1, s1, g1] = CLOUD_STOPS[next]!;
  const t = (zoom - z0) / (z1 - z0);
  return { sigmaPx: s0 + (s1 - s0) * t, gain: g0 + (g1 - g0) * t };
}

/**
 * The narrowest the blur gets in a tilted view, in device pixels, and the
 * widest, as a part of the one at the middle: close to the camera a glow
 * would fill the screen, and at three times the one of the middle the
 * nearest tracks of a steeply tilted map still grew into wide saturated
 * smears across the bottom of it. A far flight narrower than a pixel was
 * drawn as a crisp line that flickered: it is drawn this wide, and as much
 * fainter, so it fades into the distance.
 */
export const CLOUD_SIGMA_FLOOR_PX = 0.8;
export const CLOUD_SIGMA_MOST = 1.5;

/**
 * How the glow fades with its distance from the camera, as a power of the
 * distance to the middle of the map over its own: behind the middle a
 * haze, since the tracks of a tilted map pile up towards the horizon into
 * one bright band that flattened its depth, and in front of it less, so
 * the nearest tracks do not outshine the middle the view is of. Twice as
 * far as the middle a glow has 0.35 of its strength, four times as far
 * 0.13, and half as far 0.66.
 */
const CLOUD_HAZE = 1.5;
const CLOUD_NEAR_FADE = 0.6;

/**
 * How many blurs a quad reaches around its stretch, and pulls its glow
 * towards the camera for the depth test: as far as it reaches, so the
 * relief hides the glow of a flight only where it is in front of all of it
 */
const CLOUD_REACH = 3;

/**
 * How far the glow of a stretch reaches on the screen at the middle of the
 * map at the map zoom `zoom`, in CSS pixels: the 21 px of CLOUD_STOPS out
 * to 9.5, 7.5 px from 13 in. The readout of the cloud under the pointer is
 * for about as far (ui/cloudReadout.ts).
 */
export function cloudReachPx(zoom: number): number {
  return CLOUD_REACH * cloudLook(zoom).sigmaPx;
}

/**
 * Near the ground a glow is pulled further, to where the ground in front
 * of each corner of its quad lies, as the ground there rises into the
 * view the steeper, the flatter the view: it cut the glow of a runway in a
 * straight line. The ground is taken this many feet higher than the
 * cloud's, where the relief MapLibre draws can lie, and the pull is held
 * to this many blurs, so a ridge in front of a flight low over a valley
 * still hides it.
 */
export const CLOUD_GROUND_SLACK_FT = 30;
const CLOUD_GROUND_PULL = 12;

/**
 * The groundspeed of a cruise, in metres per second (100 kt). The heat of
 * a lone track flown at it is 1 at its middle (times the gain of
 * CLOUD_STOPS); one flown slower, a
 * circuit, a climb or the taxiing, glows brighter, as the heatmap does
 * where more fixes lie, for the time spent there, and where flights
 * overlap their heat adds up.
 */
export const CLOUD_REFERENCE_SPEED_MS = 51.4;

/**
 * How fast each colour channel fills with heat: a pixel of heat `h` is
 * `1 - exp(-h * k)` of each channel, which the blending adds up the same
 * way over every glow on the pixel (the "screen" of two layers). Blue
 * fills first, then green, then red, and each only comes near full, so a
 * lone cruise is a faint azure, four of them cyan, sixteen a light cyan
 * and only some sixty, the fields and the circuits flown every week,
 * white: the stops of the heatmap's colours (see HEATMAP_GRADIENT).
 */
export const CLOUD_COLOUR = [0.04, 0.26, 0.62] as const;

/**
 * The heat the busiest cells of the cloud (see CloudPoints.busiest) are
 * drawn with at most: white (see CLOUD_COLOUR). Where more than a
 * hundredth of its cells would glow hotter, the whole cloud is drawn
 * darker, down to the least of CLOUD_EXPOSURE_RANGE, so a home field
 * flown for years does not wash out its circuits and the routes out of
 * it. It is never drawn brighter than its colours are made for: the two
 * years of flights of the sample data have their busiest cells at a heat
 * of 6 to 18 (cyan), a lone flight at about 3 to 6, and drawn near white
 * they glowed white along every route.
 */
const CLOUD_WHITE_HEAT = 60;
const CLOUD_EXPOSURE_RANGE = [0.25, 1] as const;

/**
 * The shadow of the cloud: how fast each colour channel fills with heat (see
 * CLOUD_COLOUR), a muted grey blue, and the most it fills, so that under a
 * busy field it stays a haze rather than a second white blot under the
 * glow's. The shadows are not added up but the brightest is kept, which
 * the ceiling holds: added up, those of every circuit over a field filled
 * to white. The brightest is kept against what the pixel already has, the
 * map, so over ground brighter than the shadow (roads, satellite imagery)
 * none shows: keeping it against the other shadows alone needs a texture
 * of its own (see doc/development/heat.md). A stretch casts none on the
 * ground it is on (the taxiing, the run for a take-off), and a full one
 * from the second of these heights
 * above it, in feet. It is a Gaussian of the distance to the stretch,
 * which the brightest of them keeps as whole as the joins of the glow do,
 * cut at this many blurs, at half the cost of the glow. None is drawn
 * while the cloud is dimmed (see HeatCloudStyle.opacity), where it cost
 * as much as the glow for a haze no one could see.
 */
export const CLOUD_SHADOW_COLOUR = [0.22, 0.26, 0.35] as const;
export const CLOUD_SHADOW_CEILING = 0.24;
export const CLOUD_SHADOW_LIFT_FT = [30, 100] as const;
const CLOUD_SHADOW_REACH = 2;

/** The Gaussian of the shadow at its reach, taken off so it ends at 0 */
const SHADOW_EDGE = Math.exp(-0.5 * CLOUD_SHADOW_REACH ** 2);

/**
 * The pulses of the flow: how many CSS pixels a cruise flies between two
 * (see CLOUD_REFERENCE_SPEED_MS), in how many seconds one moves on to the
 * next, and how strongly they bring out and take back the glow. Along a
 * stretch where they would come closer than the first of these many blurs
 * on the screen, the taxiing close in and every track near the horizon,
 * they ran together into a comb: they fade out there from the second.
 */
export const CLOUD_FLOW_SPACING_PX = 90;
export const CLOUD_FLOW_CYCLE_S = 2.5;
export const CLOUD_FLOW_STRENGTH = 0.6;
const CLOUD_FLOW_CLOSEST = [4, 8] as const;

/**
 * The factor of a pulse at the part `phase` of its period (see
 * FRAGMENT_SHADER, which has the same): a raised cosine, skewed forward by
 * the square of the phase, so it rises along where it has been to its head
 * at 0.71 of the period and falls, a little quicker but as smoothly, ahead
 * of it. It and its slope are 0 at either end of the period, so the pulses
 * pass without a jump, where a fall to 0 in the last 15 % of it snapped.
 * CLOUD_PULSE_SCALE makes it 1 on average, 1 / (1 - C(2) / 2) with the
 * Fresnel integral C, so the heat as a whole shows as bright as without.
 */
const CLOUD_PULSE_SCALE = 1.3229730485502598;
export function cloudPulse(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * phase * phase)) * CLOUD_PULSE_SCALE;
}

/**
 * How long after the map was last used the pulses keep running, and in
 * how many seconds they fade in and out (and the exposure follows a new
 * level's)
 */
export const CLOUD_FLOW_IDLE_MS = 8000;
export const CLOUD_FADE_S = 0.8;

/**
 * What the map does when it is used, a move of its camera or a touch: each
 * wakes the flow. The pointer moving over it is not: it kept the map
 * drawing every frame for as long as it rested on it.
 */
export const CLOUD_FLOW_WAKE = ["touchstart", "move"] as const;

/**
 * The marks of the way flown, for when the pulses do not run: a chevron
 * pointing ahead along each track, where it crosses the lines of a
 * lattice laid over the ground, about this many CSS pixels apart on the
 * screen wherever the track is. Every flight along a track draws its marks
 * at the same places, so where a route is flown over and over they add up
 * to one row of marks rather than a haze of them, as marks timed by each
 * flight did. That is one row where the flights are within a stroke of
 * each other: flights a little apart, side by side or at heights that a
 * tilted map close to the camera sets apart on the screen, glow as one
 * track and still draw a row each, their strokes being far narrower than
 * the glow. Each adds a part of the heat of its stretch in its stroke and
 * takes a part away around it, so it shows on a faint track and on a white
 * one alike.
 */
export const CLOUD_MARK_SPACING_PX = 96;
const CLOUD_MARK_ADD = 1.2;
const CLOUD_MARK_CUT = 0.4;

/**
 * The size of a mark, how far its arms reach to either side of the track,
 * in blurs of the glow, and the most in CSS pixels, so a mark does not
 * outgrow a narrow track further out; the sizes in CSS pixels over which
 * the marks of a narrower glow fade out (the far distance of a tilted map,
 * where they would be a flicker of pixels); and the width of its stroke,
 * in blurs and the least and the most in CSS pixels
 */
const CLOUD_MARK_SIZE = [2.2, 12] as const;
const CLOUD_MARK_LEAST = [2, 4] as const;
const CLOUD_MARK_STROKE = [0.3, 0.6, 1.5] as const;

/**
 * The map zooms over which the marks fade in: further out the tracks of a
 * region run together, and marks there would only add noise
 */
const CLOUD_MARK_ZOOMS = [7.5, 9] as const;

/**
 * How strongly the marks are drawn at the map zoom `zoom` while the pulses
 * show at `pulses` (from 0 to 1): in place of the pulses, as they fade in
 * and out, so the cloud shows one of the two at a time
 */
export function markStrength(pulses: number, zoom: number): number {
  const [from, to] = CLOUD_MARK_ZOOMS;
  const inZoom = Math.min(Math.max((zoom - from) / (to - from), 0), 1);
  return inZoom * (1 - Math.min(Math.max(pulses, 0), 1));
}

/**
 * How brightly the cloud is drawn for its busiest heat per metre
 * `busiest` (see CloudPoints.busiest), times the gain of CLOUD_STOPS it
 * is drawn with: a factor of its heat that draws those cells in
 * CLOUD_WHITE_HEAT, within CLOUD_EXPOSURE_RANGE; 1 without any heat
 */
export function cloudExposure(busiest: number): number {
  if (!(busiest > 0)) return 1;
  const [least, most] = CLOUD_EXPOSURE_RANGE;
  return Math.min(
    Math.max(CLOUD_WHITE_HEAT / (busiest * CLOUD_REFERENCE_SPEED_MS), least),
    most,
  );
}

/**
 * The marks of the way flown, a block of their own in the shaders. The
 * vertex shader hands on how strongly the stretch may draw them at either
 * end (the marks of its points, see CloudPoints), and the lattice it draws
 * them on (`markLattice`), which is the same for every pixel of it:
 *
 * The lines of the lattice cross the axis nearest the stretch's direction
 * on the ground, in Mercator units from the origin of the points, of the
 * 16 at every 22.5 degrees: a stretch is marked where it crosses them.
 * One axis and not a blend of the two either side, whose lines would
 * cross a track at places of their own and draw two rows of marks along
 * it. Where a track turns across the middle between two axes, the two
 * stretches at the turn fade their marks out towards it (`v_marks`), where
 * the lattices of both drew a mark each, a pair of them close together.
 * The lines are a power of two of Mercator units apart, the one that puts
 * them nearest `u_marks.y` device pixels apart along the
 * stretch on the screen, and every second one of them, blended as that
 * goes from one power to the next; flights along the same track find the
 * same lines, and so do flights the other way, whose axis is the opposite
 * one and whose marks point back. Only a stretch whose time runs forward
 * draws them, the way it was flown, and none seen end on, which spans no
 * pixel. Its lattice is where the start of the stretch is among the lines,
 * counted from an even one, how many device pixels a line is from the
 * next along the stretch (0 for no marks), and how far the lines have
 * gone to every second one.
 */
const MARKS_VERTEX = `
flat out vec2 v_marks;
flat out vec3 v_lattice;
uniform vec3 u_marks;

float markAxis(vec2 from, vec2 to) {
  vec2 d = to - from;
  return floor(atan(d.y, d.x) / ${(Math.PI / 8).toFixed(8)} + 0.5);
}

vec3 markLattice(vec4 ground, float length_px, vec2 time) {
  float units = distance(ground.xy, ground.zw);
  if (u_marks.x <= 0.0 || time.y <= time.x || units <= 0.0 || length_px < 1e-3) {
    return vec3(0.0);
  }
  float perUnit = length_px / units;
  vec2 d = (ground.zw - ground.xy) / units;
  float octave = log2(u_marks.y / perUnit);
  float apart = exp2(floor(octave));
  float axis = markAxis(ground.xy, ground.zw) * ${(Math.PI / 8).toFixed(8)};
  vec2 normal = vec2(cos(axis), sin(axis));
  float line = dot(ground.xy, normal) / apart;
  return vec3(
    line - 2.0 * floor(0.5 * line),
    perUnit * apart / dot(d, normal),
    octave - floor(octave)
  );
}
`;

/**
 * The fragment shader finds where the pixel is among the lines of the
 * lattice of its stretch (`v_lattice`), and draws a chevron at the nearest
 * one, pointing ahead, its arms reaching CLOUD_MARK_SIZE to either side;
 * a pixel further across than they reach keeps its glow as it is. Its
 * stroke adds the heat of the stretch there (CLOUD_MARK_ADD), spread along
 * it as the glow is, so the stretches of a flight hand a mark on at their
 * joins, and a band as wide around it takes away the glow
 * (CLOUD_MARK_CUT), each times the strength (`u_marks.x`) and the
 * stretch's own marks (`v_marks`). `u_marks.z` is the device pixels of a
 * CSS pixel.
 */
const MARKS_FRAGMENT = `
flat in vec2 v_marks;
flat in vec3 v_lattice;
uniform vec3 u_marks;

vec2 chevron(float ahead, float across, float size, float stroke) {
  float arm = abs(ahead - 0.4 * size + 0.8 * abs(across)) * 0.78086881;
  return vec2(
    (1.0 - smoothstep(stroke - 0.5, stroke + 0.5, arm))
      * (1.0 - smoothstep(size - 0.5, size + 0.5, abs(across))),
    (1.0 - smoothstep(2.0 * stroke - 0.5, 2.0 * stroke + 0.5, arm))
      * (1.0 - smoothstep(size + stroke - 0.5, size + stroke + 0.5, abs(across)))
  );
}

float marked(float glow, vec2 p, vec2 dir, float across, float t, float sigma, float scale, float spread) {
  float spacing = v_lattice.y;
  float size = min(${CLOUD_MARK_SIZE[0].toFixed(1)} * sigma, ${CLOUD_MARK_SIZE[1].toFixed(1)} * u_marks.z);
  float stroke = clamp(${CLOUD_MARK_STROKE[0].toFixed(1)} * sigma, ${CLOUD_MARK_STROKE[1].toFixed(1)} * u_marks.z, ${CLOUD_MARK_STROKE[2].toFixed(1)} * u_marks.z);
  if (spacing <= 0.0 || abs(across) >= size + stroke + 0.5) return glow;
  float strength = u_marks.x * mix(v_marks.x, v_marks.y, t)
    * smoothstep(${CLOUD_MARK_LEAST[0].toFixed(1)} * u_marks.z, ${CLOUD_MARK_LEAST[1].toFixed(1)} * u_marks.z, size);
  if (strength <= 0.0) return glow;
  vec2 a = v_ends.xy;
  vec2 b = v_ends.zw;
  float line = v_lattice.x + dot(p - a, dir) / spacing;
  float half_line = 0.5 * line;
  vec2 mark = mix(
    chevron((line - floor(line + 0.5)) * spacing, across, size, stroke),
    chevron((half_line - floor(half_line + 0.5)) * 2.0 * spacing, across, size, stroke),
    v_lattice.z
  ) * strength;
  return glow * (1.0 - ${CLOUD_MARK_CUT.toFixed(2)} * mark.y)
    + ${CLOUD_MARK_ADD.toFixed(2)} * mark.x * v_heat * scale
      * 0.5 * (erf(dot(p - a, v_joins.xy) * spread) + erf(dot(b - p, v_joins.zw) * spread));
}
`;

/**
 * The quad of a stretch, and what its pixels need to know of it:
 * - The joins, where the stretch hands over to the one before and the one
 *   after, are the bisectors of the angles between them, which are as far
 *   from either line, so their glows meet without a gap or an overlap
 *   where it bends.
 * - Across a stretch shorter than its blur the two joins would open into a
 *   wedge far longer than the stretch, all of it lit with the heat of that
 *   stretch: those meet the next straight across (`bend`), as the heat of
 *   a short stretch is a soft point anyway.
 * - The quad reaches past each end by the reach of the glow, and as far
 *   again as the bisector slants away from the end at that distance
 *   across; the shadow's only by its reach (CLOUD_SHADOW_REACH).
 * - It is pulled towards the camera by its reach, where it is still on the
 *   same pixels, with the depth the projection gives there; and a corner
 *   the ground in front of it is nearer than that to where the ground is
 *   (CLOUD_GROUND_PULL): the plane of the ground under its end, through
 *   three points of it projected, meets the ray through the corner there.
 *   Never nearer than halfway to the camera, nor than its near plane.
 * - The shadow of a stretch shorter than its blur is as bright as the
 *   glow's erf makes it in its middle: a soft point, where the brightest
 *   of them is kept.
 * - Its pulses come as far apart on the screen as its length over the
 *   periods of the flight's time along it (CLOUD_FLOW_CLOSEST).
 * - A stretch is cut where the clock of the replay of all flights has
 *   come to (`u_until`), and one that begins later is left out whole; the
 *   end cut has no join with the next.
 * - A stretch that reaches behind the camera's near plane is cut there
 *   (`kept`, the part of it left, from its start), and its ends have the
 *   time, height, marks and place on the ground of the ends of that part,
 *   the ground its glow is pulled to among them, and its pixels the heat
 *   of that part, so what is drawn of it is where and when it was flown
 *   and its marks meet those of the next.
 */
export const VERTEX_SHADER = `
in vec2 a_corner;
in vec4 a_before;
in float a_in;
in vec4 a_start;
in vec3 a_heat;
in vec4 a_end;
in vec3 a_out;
in vec4 a_after;
uniform vec2 u_heights;
uniform vec3 u_centre;
uniform vec2 u_viewport;
uniform vec3 u_sigma;
uniform vec4 u_depth;
uniform float u_gain;
uniform vec2 u_ground;
uniform vec2 u_shadow;
uniform vec4 u_flow;
uniform vec2 u_flowMix;
uniform float u_until;
flat out vec4 v_ends;
flat out vec4 v_joins;
flat out vec4 v_blur;
flat out float v_heat;
flat out vec2 v_time;
flat out float v_flow;
${MARKS_VERTEX}
vec4 project(vec4 point) {
  return projectTileFor3D(point.xy, point.z * u_heights.x + point.w * u_heights.y);
}

vec2 onScreen(vec4 clip) {
  return (clip.xy / clip.w * 0.5 + 0.5) * u_viewport;
}

vec2 unit(vec2 v, vec2 otherwise) {
  float l = length(v);
  return l > 1e-3 ? v / l : otherwise;
}

float meet(vec4 o, vec4 e, vec4 n, vec2 at) {
  vec2 q = at / u_viewport * 2.0 - 1.0;
  vec2 r = q * o.w - o.xy;
  vec2 ce = e.xy - q * e.w;
  vec2 cn = n.xy - q * n.w;
  float det = ce.x * cn.y - ce.y * cn.x;
  if (abs(det) <= 1e-6 * length(ce) * length(cn)) return 0.0;
  return o.w + (e.w * (r.x * cn.y - r.y * cn.x) + n.w * (ce.x * r.y - ce.y * r.x)) / det;
}

void main() {
  bool shadow = u_shadow.y > 0.0;
  float shade = shadow ? smoothstep(u_shadow.x, u_shadow.y, max(a_start.w, a_end.w)) : 1.0;
  vec4 a = project(a_start);
  float flown = a_out.y > u_until ? (u_until - a_heat.y) / (a_out.y - a_heat.y) : 1.0;
  vec4 b = mix(a, project(a_end), flown);
  float near = u_depth.z;
  if (
    a_heat.x <= 0.0 || a_heat.y >= u_until || shade <= 0.0 || (a.w < near && b.w < near)
  ) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vec2 kept = vec2(0.0, flown);
  if (a.w < near) {
    float cut = (near - a.w) / (b.w - a.w);
    a = mix(a, b, cut);
    kept.x = cut * flown;
  }
  if (b.w < near) {
    float cut = (near - b.w) / (a.w - b.w);
    b = mix(b, a, cut);
    kept.y = mix(kept.y, kept.x, cut);
  }
  float middle = projectTileFor3D(u_centre.xy, u_centre.z).w;
  vec2 scales = vec2(middle / a.w, middle / b.w);
  vec2 blurs = u_sigma.x * scales;
  vec2 sigmas = clamp(blurs, u_sigma.y, u_sigma.z);
  vec2 pa = onScreen(a);
  vec2 pb = onScreen(b);
  float length_px = distance(pa, pb);
  vec2 dir = unit(pb - pa, vec2(1.0, 0.0));
  vec2 joinA = dir;
  vec2 joinB = dir;
  if (a_in > 0.0) {
    vec4 c = project(a_before);
    if (c.w > near) joinA = unit(unit(pa - onScreen(c), dir) + dir, dir);
  }
  if (a_out.x > 0.0 && flown >= 1.0) {
    vec4 c = project(a_after);
    if (c.w > near) joinB = unit(dir + unit(onScreen(c) - pb, dir), dir);
  }
  float bend = smoothstep(0.5, 2.0, length_px / min(sigmas.x, sigmas.y));
  joinA = unit(mix(dir, joinA, bend), dir);
  joinB = unit(mix(dir, joinB, bend), dir);
  bool atEnd = a_corner.x > 0.0;
  float sigma = atEnd ? sigmas.y : sigmas.x;
  float w = atEnd ? b.w : a.w;
  float slant = clamp(dot(atEnd ? joinB : joinA, dir), 0.5, 1.0);
  float reach = (shadow ? ${CLOUD_SHADOW_REACH.toFixed(1)} : ${CLOUD_REACH.toFixed(1)}) * sigma;
  vec2 corner = (atEnd ? pb : pa)
    + dir * a_corner.x * reach * (shadow ? 1.0 : 1.0 + sqrt(max(1.0 - slant * slant, 0.0)) / slant)
    + vec2(-dir.y, dir.x) * a_corner.y * reach;
  float pull = reach * w / u_depth.w;
  float pulled = w - pull;
  vec4 point = mix(a_start, a_end, atEnd ? kept.y : kept.x);
  float h = point.z * u_heights.x + u_ground.y;
  vec4 o = projectTileFor3D(point.xy, h);
  vec4 e = projectTileFor3D(point.xy + vec2(u_ground.x, 0.0), h) - o;
  vec4 n = projectTileFor3D(point.xy + vec2(0.0, u_ground.x), h) - o;
  float behind = meet(o, e, n, atEnd ? pb : pa);
  float under = meet(o, e, n, corner);
  if (behind > 0.0 && behind < w + pull && under > 0.0 && under < pulled) {
    pulled = mix(
      max(under, w - ${CLOUD_GROUND_PULL.toFixed(1)} * sigma * w / u_depth.w),
      pulled,
      max(behind - w, 0.0) / pull
    );
  }
  pulled = max(pulled, max(0.5 * w, near * 1.01));
  gl_Position = vec4(
    (corner / u_viewport * 2.0 - 1.0) * pulled,
    u_depth.y - u_depth.x * pulled,
    pulled
  );
  v_ends = vec4(pa, pb);
  v_joins = vec4(joinA, joinB);
  v_blur = vec4(
    sigmas,
    scales * min(blurs / sigmas, 1.0)
      * pow(min(scales, 1.0), vec2(${CLOUD_HAZE.toFixed(2)}))
      * pow(max(scales, 1.0), vec2(-${CLOUD_NEAR_FADE.toFixed(2)}))
  );
  if (shadow) {
    float f = length_px / (1.4142136 * (sigmas.x + sigmas.y));
    shade *= sqrt(1.0 - exp(-1.2732395 * f * f));
  }
  v_heat = shade * u_gain * a_heat.x * (kept.y - kept.x) / max(length_px, 1e-3);
  v_time = mix(vec2(a_heat.y), vec2(a_out.y), kept);
  v_marks = mix(vec2(a_heat.z), vec2(a_out.z), kept);
  float axis = markAxis(a_start.xy, a_end.xy);
  if (a_in > 0.0 && mod(markAxis(a_before.xy, a_start.xy) - axis, 8.0) != 0.0) v_marks.x = 0.0;
  if (a_out.x > 0.0 && mod(markAxis(a_end.xy, a_after.xy) - axis, 8.0) != 0.0) v_marks.y = 0.0;
  v_lattice = markLattice(
    vec4(mix(a_start.xy, a_end.xy, kept.x), mix(a_start.xy, a_end.xy, kept.y)),
    length_px,
    v_time
  );
  float periods = abs(v_time.y - v_time.x) * u_flow.x / (1.0 + u_flowMix.x);
  v_flow = shadow ? 0.0 : smoothstep(
    ${CLOUD_FLOW_CLOSEST[0].toFixed(1)},
    ${CLOUD_FLOW_CLOSEST[1].toFixed(1)},
    length_px / max(periods, 1e-6) / (0.5 * (sigmas.x + sigmas.y))
  );
}
`;

/**
 * The glow of a pixel of a stretch: the Gaussian across the stretch,
 * integrated along it from the join with the one before to the join with
 * the one after; of the shadow, the Gaussian of its distance to the
 * stretch, down to 0 at its reach. With the flow, times its pulses at the
 * time the pixel was flown at, in two periods, one twice the other,
 * blended as the zoom goes from one to the next; a pulse is brightest at
 * its head and fades along where it has been, and is 1 on average.
 */
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in vec4 v_ends;
flat in vec4 v_joins;
flat in vec4 v_blur;
flat in float v_heat;
flat in vec2 v_time;
flat in float v_flow;
uniform vec3 u_colour;
uniform float u_ceiling;
uniform vec2 u_shadow;
uniform vec4 u_flow;
uniform vec2 u_flowMix;
out vec4 fragColor;

float pulse(float phase) {
  return (1.0 - cos(6.2831853 * phase * phase)) * ${CLOUD_PULSE_SCALE.toFixed(7)};
}

// Abramowitz and Stegun 7.1.26, to 1.5e-7
float erf(float x) {
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return sign(x) * y;
}
${MARKS_FRAGMENT}
void main() {
  vec2 a = v_ends.xy;
  vec2 b = v_ends.zw;
  vec2 p = gl_FragCoord.xy;
  float length_px = distance(a, b);
  vec2 dir = length_px > 1e-3 ? (b - a) / length_px : v_joins.xy;
  float across = dot(p - a, vec2(-dir.y, dir.x));
  float t = length_px > 1e-3 ? clamp(dot(p - a, dir) / length_px, 0.0, 1.0) : 0.5;
  float sigma = mix(v_blur.x, v_blur.y, t);
  float scale = mix(v_blur.z, v_blur.w, t);
  float glow;
  if (u_shadow.y > 0.0) {
    float off = distance(p, a + dir * clamp(dot(p - a, dir), 0.0, length_px)) / sigma;
    glow = v_heat * scale * max(exp(-0.5 * off * off) - ${SHADOW_EDGE.toFixed(6)}, 0.0)
      / ${(1 - SHADOW_EDGE).toFixed(6)};
  } else {
    float spread = 0.70710678 / sigma;
    glow = v_heat * scale * exp(-0.5 * across * across / (sigma * sigma))
      * 0.5 * (erf(dot(p - a, v_joins.xy) * spread) + erf(dot(b - p, v_joins.zw) * spread));
    if (u_marks.x > 0.0) glow = marked(glow, p, dir, across, t, sigma, scale, spread);
  }
  if (u_flowMix.y * v_flow > 0.0) {
    float time = mix(v_time.x, v_time.y, t);
    float pulses = mix(
      pulse(fract(time * u_flow.x - u_flow.z)),
      pulse(fract(time * u_flow.y - u_flow.w)),
      u_flowMix.x
    );
    glow *= 1.0 + u_flowMix.y * v_flow * (pulses - 1.0);
  }
  vec3 filled = u_ceiling * (1.0 - exp(-glow * u_colour / u_ceiling));
  if (filled.b < 0.002) discard;
  fragColor = vec4(filled, max(filled.r, max(filled.g, filled.b)));
}
`;

/** The attributes, at locations of their own in every program */
export const ATTRIBUTES = [
  "a_corner",
  "a_before",
  "a_in",
  "a_start",
  "a_heat",
  "a_end",
  "a_out",
  "a_after",
] as const;

/** The uniforms besides those of the projection */
export const UNIFORMS = [
  "u_heights",
  "u_centre",
  "u_viewport",
  "u_sigma",
  "u_depth",
  "u_gain",
  "u_ground",
  "u_shadow",
  "u_colour",
  "u_ceiling",
  "u_flow",
  "u_flowMix",
  "u_marks",
  "u_until",
] as const;

/**
 * A stretch is the point it starts from and the one after it, with the
 * points on either side of them for the joins, the heat of the stretches
 * before and after it, and the time and the marks at either end
 */
export function layout(gl: WebGL2RenderingContext): void {
  const stride = CLOUD_POINT_FLOATS * 4;
  for (let point = 0; point < 4; point++) {
    const location = 1 + 2 * point;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(
      location,
      4,
      gl.FLOAT,
      false,
      stride,
      point * stride,
    );
    gl.vertexAttribDivisor(location, 1);
    if (point === 3) continue;
    gl.enableVertexAttribArray(location + 1);
    gl.vertexAttribPointer(
      location + 1,
      point ? 3 : 1,
      gl.FLOAT,
      false,
      stride,
      point * stride + 16,
    );
    gl.vertexAttribDivisor(location + 1, 1);
  }
}
