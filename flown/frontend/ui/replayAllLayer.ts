/**
 * The layer of the replay of all flights (ui/replayAll.ts): every flight as
 * a bright head with a trail that fades behind it, drawn with shaders of
 * its own, as the heat cloud is (ui/heatCloudLayer.ts), since moving a
 * hundred markers and writing a hundred trails to a source every frame is
 * far too slow. The curves of all flights are uploaded once, each point
 * with the seconds into its flight (calculations/replayAll.ts), and a
 * frame only tells the shaders the time: a stretch between two points
 * that has not begun is not drawn, one that has is drawn as far as the
 * time has come, and fades by how long ago each of its pixels was flown.
 * The heads are drawn from the same stretches, one at the tip of the
 * stretch each flight is on. A trail glows in its colour: its own amber,
 * or the colour of the colour layer that is on along it (see
 * replayAllPoints), the line with a soft halo round it.
 *
 * It projects with MapLibre's own code, as the cloud does, so it works on
 * the globe, at the heights of the ribbons and the cloud, and against the
 * relief in the depth buffer without writing to it.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import {
  REPLAY_ALL_POINT_FLOATS,
  type ReplayAllPoints,
} from "../calculations/replayAll";
import {
  drawing,
  LayerGl,
  setDepth,
  setProjection,
  worldCopies,
} from "./glLayer";

/** The id of the layer on the map */
export const REPLAY_ALL_LAYER = "replay-all";

/**
 * The id of the layer of the intro of a link to shared flights
 * (ui/shareIntro.ts), the same player's, which a replay may start next to
 */
export const SHARE_INTRO_LAYER = "share-intro";

/**
 * Half the width of a trail and the reach of a head's glow, in CSS pixels.
 * A trail's glow reaches three times as far as the line, where it fades
 * below what is drawn: wider, it was four times the pixels of the line
 * for every stretch.
 */
const TRAIL_HALF_WIDTH_PX = 1.5;
const HEAD_RADIUS_PX = 7;

/** What the layer asks for every frame it draws */
export interface ReplayAllStyle {
  /** Metres a foot of the ground and of the height above it is drawn as */
  groundM: number;
  liftM: number;
  /** The seconds into every flight */
  time: number;
  /** The seconds of flight a trail takes to fade */
  fade: number;
  /** How many times their size the heads and trails are drawn */
  scale: number;
}

/**
 * A stretch is not drawn where it is the step from one curve to the next,
 * not flown yet or faded away, for the heads where no flight is on it, and
 * for the trails where its colour is negative (see replayAllPoints). Each
 * is pulled towards the camera for the depth test by the reach of a head
 * or of the line of a trail, so a flight on the ground is not cut by the
 * ground it stands on: by the reach of a trail's glow, three times the
 * line's, it showed through more of the ridges and ribbons in front of it.
 * The colour of a stretch is the one of its end, its three bytes in one
 * number, exact in a float, or none (0) for the trail's own; negated, the
 * trail leaves the stretch out, and a head on it is drawn in it.
 */
const VERTEX_SHADER = `
in vec2 a_corner;
in vec4 a_start;
in vec3 a_startClock;
in vec4 a_end;
in vec3 a_endClock;
uniform vec2 u_heights;
uniform vec2 u_viewport;
uniform vec4 u_depth;
uniform vec3 u_clock;
uniform vec2 u_size;
flat out vec4 v_ends;
flat out vec2 v_times;
flat out vec3 v_colour;

const vec3 TRAIL = vec3(1.0, 0.7, 0.28);

vec4 project(vec4 point) {
  return projectTileFor3D(point.xy, point.z * u_heights.x + point.w * u_heights.y);
}

vec2 onScreen(vec4 clip) {
  return (clip.xy / clip.w * 0.5 + 0.5) * u_viewport;
}

void main() {
  float now = u_clock.x;
  bool head = u_clock.z > 0.5;
  float t0 = a_startClock.x;
  float t1 = a_endClock.x;
  float near = u_depth.z;
  if (a_startClock.y < 0.5 || t0 > now || t1 < now - u_clock.y
    || (head ? t1 <= now : a_endClock.z < 0.0)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  float cut = t1 > t0 ? min((now - t0) / (t1 - t0), 1.0) : 1.0;
  vec4 a = project(a_start);
  vec4 b = project(mix(a_start, a_end, cut));
  if (a.w < near && b.w < near) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  if (a.w < near) a = mix(a, b, (near - a.w) / (b.w - a.w));
  if (b.w < near) b = mix(b, a, (near - b.w) / (a.w - b.w));
  vec2 pa = onScreen(a);
  vec2 pb = onScreen(b);
  vec2 corner = pb + a_corner * u_size.y;
  float w = b.w;
  float reach = u_size.y;
  if (!head) {
    vec2 d = pb - pa;
    float l = length(d);
    vec2 dir = l > 1e-3 ? d / l : vec2(1.0, 0.0);
    reach = u_size.x + 1.0;
    bool atEnd = a_corner.x > 0.0;
    corner = (atEnd ? pb : pa)
      + vec2(-dir.y, dir.x) * a_corner.y * (3.0 * u_size.x + 1.0);
    w = atEnd ? b.w : a.w;
  }
  // Not past the near plane either, as in the heat cloud: an end just
  // beyond it was pulled through and clipped
  float pulled = max(w - reach * w / u_depth.w, max(0.5 * w, near * 1.01));
  gl_Position = vec4(
    (corner / u_viewport * 2.0 - 1.0) * pulled,
    u_depth.y - u_depth.x * pulled,
    pulled
  );
  v_ends = vec4(pa, pb);
  v_times = vec2(t0, mix(t0, t1, cut));
  float c = abs(a_endClock.z);
  v_colour = c > 0.0
    ? vec3(floor(c / 65536.0), mod(floor(c / 256.0), 256.0), mod(c, 256.0)) / 255.0
    : TRAIL;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
flat in vec4 v_ends;
flat in vec2 v_times;
flat in vec3 v_colour;
uniform vec3 u_clock;
uniform vec2 u_size;
out vec4 fragColor;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 a = v_ends.xy;
  vec2 b = v_ends.zw;
  float alpha;
  vec3 colour = v_colour;
  if (u_clock.z > 0.5) {
    float d = distance(p, b) / u_size.y;
    float core = 1.0 - smoothstep(0.25, 0.4, d);
    alpha = max(core, 0.7 * exp(-8.0 * d * d));
    colour = mix(colour, vec3(1.0), core);
  } else {
    vec2 d = b - a;
    float l = max(length(d), 1e-3);
    vec2 dir = d / l;
    float s = clamp(dot(p - a, dir) / l, 0.0, 1.0);
    float across = abs(dot(p - a, vec2(-dir.y, dir.x)));
    float age = (u_clock.x - mix(v_times.x, v_times.y, s)) / u_clock.y;
    float fade = 1.0 - clamp(age, 0.0, 1.0);
    float glow = across / (1.25 * u_size.x);
    alpha = max(
      0.85 * clamp(u_size.x + 0.5 - across, 0.0, 1.0),
      0.5 * exp(-glow * glow)
    ) * fade * fade;
  }
  if (alpha < 0.004) discard;
  fragColor = vec4(colour * alpha, alpha);
}
`;

const ATTRIBUTES = [
  "a_corner",
  "a_start",
  "a_startClock",
  "a_end",
  "a_endClock",
] as const;

/** The uniforms besides those of the projection */
const UNIFORMS = [
  "u_heights",
  "u_viewport",
  "u_depth",
  "u_clock",
  "u_size",
] as const;

/**
 * A stretch is the point it starts from and the one after it: where each
 * is, then its time, whether it joins the next and its colour
 */
function layout(gl: WebGL2RenderingContext): void {
  const stride = REPLAY_ALL_POINT_FLOATS * 4;
  for (let point = 0; point < 2; point++) {
    for (const [slot, size, offset] of [
      [1, 4, 0],
      [2, 3, 16],
    ] as const) {
      const location = slot + 2 * point;
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        size,
        gl.FLOAT,
        false,
        stride,
        point * stride + offset,
      );
      gl.vertexAttribDivisor(location, 1);
    }
  }
}

export class ReplayAllLayer implements CustomLayerInterface {
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  /** Frames the layer has drawn, and the time of the last, for the e2e tests */
  frames = 0;
  time = 0;
  private map: MapLibreMap | null = null;
  /** Its GL objects, made as it first draws (see LayerGl) */
  private readonly objects: LayerGl<(typeof UNIFORMS)[number]>;
  private flights: ReplayAllPoints | null = null;

  /**
   * `style` is asked on every frame, and draws nothing where it gives null;
   * `failed` is told when the shaders do not work in the map's context.
   * `id` is the replay's unless another player draws at the same time (the
   * intro of a link to shared flights, ui/shareIntro.ts, whose trails may
   * still stand in for the lines as a replay of the map starts).
   */
  constructor(
    private readonly style: () => ReplayAllStyle | null,
    private readonly failed: (error: unknown) => void,
    readonly id = REPLAY_ALL_LAYER,
  ) {
    this.objects = new LayerGl(
      {
        owner: "the replay's",
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        attributes: ATTRIBUTES,
        uniforms: UNIFORMS,
        layout,
      },
      this.failed,
    );
  }

  /** Draw the points `flights` from the next frame on, or none */
  setPoints(flights: ReplayAllPoints | null): void {
    this.flights = flights;
    this.map?.triggerRepaint();
  }

  onAdd(map: MapLibreMap): void {
    this.map = map;
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = null;
    this.objects.release(gl);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    const flights = this.flights;
    const style = this.style();
    if (!map || !flights || flights.count < 2 || !style) return;
    const ready = this.objects.begin(gl, options, flights);
    if (!ready) return;

    const u = ready.program.uniforms;
    const height = gl.drawingBufferHeight;
    const ratio = map.getPixelRatio();
    gl.uniform2f(u.u_heights, style.groundM, style.liftM);
    gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, height);
    setDepth(gl, u.u_depth, options, height);
    const size = ratio * style.scale;
    gl.uniform2f(u.u_size, TRAIL_HALF_WIDTH_PX * size, HEAD_RADIUS_PX * size);

    gl.bindVertexArray(ready.vao);
    drawing(gl);
    // Premultiplied, over what the map has drawn
    gl.blendFuncSeparate(
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    // The trails, then the heads over them, each in every world copy the
    // view shows (see worldCopies): no copy's trails over another's heads
    const lat = map.getCenter().lat;
    const copies = worldCopies(map, options, flights.xs);
    for (const head of [0, 1]) {
      gl.uniform3f(u.u_clock, style.time, Math.max(style.fade, 1), head);
      for (const copy of copies) {
        const origin = [flights.origin[0] + copy, flights.origin[1]] as const;
        setProjection(gl, u, options, origin, lat);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, flights.count - 1);
      }
    }
    this.frames++;
    this.time = style.time;
  }
}
