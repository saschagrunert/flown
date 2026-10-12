/**
 * What the app's two custom WebGL layers, the heat cloud
 * (ui/heatCloudLayer.ts) and the replay of all flights
 * (ui/replayAllLayer.ts), do alike: a quad drawn per stretch between two
 * points, from a buffer of points uploaded once; a program per projection,
 * built on the prelude MapLibre hands a custom layer, so the same shaders
 * work on the globe; and GL objects made for one context, anew after it
 * was lost. The programs that compiled outlast the layer's time off the
 * map, as long as their context does.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import { focalLengthPx } from "../utils/geometry";
import { mercatorX } from "../utils/mercator";

/**
 * MapLibre's sphere, whose circumference its Mercator heights are in
 * (mercatorZfromAltitude): the app's EARTH_CIRCUMFERENCE_M is the WGS84
 * equator's
 */
const MAPLIBRE_EARTH_RADIUS_M = 6371008.8;

/** The uniforms of MapLibre's projection prelude, set by setProjection */
const PROJECTION_UNIFORMS = [
  "u_projection_matrix",
  "u_projection_tile_mercator_coords",
  "u_projection_clipping_plane",
  "u_projection_transition",
  "u_projection_fallback_matrix",
] as const;

type ProjectionUniform = (typeof PROJECTION_UNIFORMS)[number];

/** A compiled program and where its uniforms are */
export interface Program<U extends string> {
  program: WebGLProgram;
  uniforms: Record<U | ProjectionUniform, WebGLUniformLocation | null>;
}

/** The shaders of a layer and how its points are read */
export interface LayerShaders<U extends string> {
  /** Whose they are, for the errors: "the cloud's" */
  owner: string;
  /** The vertex shader, after MapLibre's prelude for the projection */
  vertex: string;
  fragment: string;
  /** The attributes, at locations of their own, `a_corner` the first */
  attributes: readonly string[];
  /** The uniforms besides the projection's */
  uniforms: readonly U[];
  /**
   * Point the attributes after the corner at the buffer of points, which
   * is bound, in the vertex array, which is bound as well
   */
  layout: (gl: WebGL2RenderingContext) => void;
}

/** The GL objects of a layer, made for one context */
interface Resources<U extends string> {
  gl: WebGL2RenderingContext;
  corners: WebGLBuffer;
  points: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  /**
   * By MapLibre's shader variant, one per projection; null did not work,
   * which holds while the layer stays on the map (see release)
   */
  programs: Map<string, Program<U> | null>;
  /** What the points uploaded to `points` are of */
  uploaded: object | null;
}

/**
 * The GL objects of a custom layer. They are made as it first draws, in a
 * frame: MapLibre keeps track of what is bound in its context, and takes it
 * up anew only after a custom layer has drawn. A lost context takes the
 * layer off the map (MapLibre calls onRemove before it says the context is
 * lost), the app adds it again once the context is back, and what was made
 * in the one before is gone with it.
 */
export class LayerGl<U extends string> {
  private resources: Resources<U> | null = null;
  /**
   * The programs of a layer taken off the map, for when it is added again
   * in the same context: the cloud comes and goes with the 3D view, and
   * compiling its shaders anew was part of the stall of each return
   */
  private kept: Pick<Resources<U>, "gl" | "programs"> | null = null;

  /**
   * `failed` is told when the shaders or buffers do not work in a context.
   * Not while the context is lost: every GL object is null then and no
   * shader compiles, which says nothing of the next context.
   */
  constructor(
    private readonly shaders: LayerShaders<U>,
    private readonly failed: (error: unknown) => void,
  ) {}

  /**
   * Ready to draw `data` in the frame `options`: its points uploaded where
   * they are new, and the program for the frame's projection in use. The
   * program and the vertex array to bind; null where either cannot be
   * made (see `failed`).
   */
  begin(
    gl: WebGL2RenderingContext,
    options: CustomRenderMethodInput,
    data: { points: Float32Array },
  ): { program: Program<U>; vao: WebGLVertexArrayObject } | null {
    const resources = this.resourcesOf(gl);
    const program = resources && this.program(resources, options);
    if (!resources || !program) return null;
    if (resources.uploaded !== data) {
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.points);
      gl.bufferData(gl.ARRAY_BUFFER, data.points, gl.STATIC_DRAW);
      resources.uploaded = data;
    }
    gl.useProgram(program.program);
    return { program, vao: resources.vao };
  }

  /**
   * Let go of the points uploaded in `gl`, in a frame: a layer that stays
   * on the map without points to draw would keep the last ones it drew, in
   * the buffer and in `uploaded`, for as long as it stays. The buffer is
   * left empty rather than deleted, for the points of its next draw, and
   * bound, as `begin` leaves it: MapLibre takes its state up anew after a
   * custom layer's frame.
   */
  empty(gl: WebGL2RenderingContext): void {
    const resources = this.resources;
    if (resources?.gl !== gl || !resources.uploaded) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.points);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);
    resources.uploaded = null;
  }

  /**
   * Let go of the buffers made in `gl`, unless that context is lost, and
   * keep the programs for the layer's return. Not what did not compile:
   * that took the layer off the map (see `failed`), and it comes back only
   * in a new context, which after a loss it did not hear of while off the
   * map is the very same object. Kept, the failure was handed out there
   * again without a word: the heat cloud drew nothing while the heatmap
   * stood aside for it, and `failed` was never told.
   */
  release(gl: WebGL2RenderingContext): void {
    const resources = this.resources;
    this.resources = null;
    if (!resources || resources.gl !== gl || gl.isContextLost()) return;
    gl.deleteBuffer(resources.corners);
    gl.deleteBuffer(resources.points);
    gl.deleteVertexArray(resources.vao);
    const programs: Resources<U>["programs"] = new Map();
    for (const [variant, program] of resources.programs) {
      if (program) programs.set(variant, program);
    }
    this.kept = { gl, programs };
  }

  /** The GL objects for the context `gl`, made the first time */
  private resourcesOf(gl: WebGL2RenderingContext): Resources<U> | null {
    if (this.resources?.gl === gl) return this.resources;
    this.resources = null;
    try {
      this.resources = this.makeResources(gl);
    } catch (error) {
      if (!gl.isContextLost()) this.failed(error);
    }
    return this.resources;
  }

  /** The program for the projection of the frame, compiled on first use */
  private program(
    resources: Resources<U>,
    options: CustomRenderMethodInput,
  ): Program<U> | null {
    const { variantName, vertexShaderPrelude, define } = options.shaderData;
    const held = resources.programs.get(variantName);
    if (held !== undefined) return held;
    let program: Program<U> | null = null;
    try {
      program = this.compile(
        resources.gl,
        `#version 300 es\n${vertexShaderPrelude}\n${define}\n${this.shaders.vertex}`,
      );
    } catch (error) {
      // Compiled again in a frame after the context is back
      if (resources.gl.isContextLost()) return null;
      this.failed(error);
    }
    resources.programs.set(variantName, program);
    return program;
  }

  /** The buffers of a context: a quad's corners and the points */
  private makeResources(gl: WebGL2RenderingContext): Resources<U> {
    const corners = gl.createBuffer();
    const points = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!corners || !points || !vao) {
      throw new Error(`${this.shaders.owner} buffers could not be made`);
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, points);
    this.shaders.layout(gl);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const programs = this.keptIn(gl);
    return { gl, corners, points, vao, programs, uploaded: null };
  }

  /**
   * The programs kept from before in `gl`, where they still work in it: a
   * context lost while the layer was off the map, which it did not hear
   * of, comes back as the same object without them
   */
  private keptIn(gl: WebGL2RenderingContext): Resources<U>["programs"] {
    const kept = this.kept;
    this.kept = null;
    if (
      kept?.gl !== gl ||
      [...kept.programs.values()].some(
        (program) => program && !gl.isProgram(program.program),
      )
    ) {
      return new Map();
    }
    return kept.programs;
  }

  /** Compile and link the program of `vertex` and the fragment shader */
  private compile(gl: WebGL2RenderingContext, vertex: string): Program<U> {
    const { owner, fragment, attributes, uniforms } = this.shaders;
    const program = gl.createProgram();
    const shaders = [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const;
    for (const [type, source] of shaders) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error(`${owner} shaders could not be made`);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        gl.deleteProgram(program);
        throw new Error(`${owner} shader did not compile: ${log}`);
      }
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    attributes.forEach((name, location) =>
      gl.bindAttribLocation(program, location, name),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`${owner} program did not link: ${log}`);
    }
    const located = Object.fromEntries(
      [...PROJECTION_UNIFORMS, ...uniforms].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    ) as Program<U>["uniforms"];
    return { program, uniforms: located };
  }
}

/**
 * The matrices setProjection hands the shaders, made once: a layer sets
 * them for each pass and each world copy of every frame, and WebGL copies
 * them as they are set
 */
const mercatorScratch = new Float32Array(16);
const mainScratch = new Float32Array(16);

/**
 * Set the uniforms of MapLibre's projection prelude for points given from
 * `origin` (see cloudMatrix), on the map or the globe, in the program in use
 */
export function setProjection(
  gl: WebGL2RenderingContext,
  u: Record<ProjectionUniform, WebGLUniformLocation | null>,
  options: CustomRenderMethodInput,
  origin: readonly [number, number],
  lat: number,
): void {
  const data = options.defaultProjectionData;
  const globe = options.shaderData.define.includes("GLOBE");
  const mercator = cloudMatrix(
    globe ? data.fallbackMatrix : data.mainMatrix,
    origin,
    lat,
    mercatorScratch,
  );
  if (globe) mainScratch.set(data.mainMatrix);
  gl.uniformMatrix4fv(
    u.u_projection_matrix,
    false,
    globe ? mainScratch : mercator,
  );
  if (globe) {
    gl.uniformMatrix4fv(u.u_projection_fallback_matrix, false, mercator);
    gl.uniform4f(
      u.u_projection_tile_mercator_coords,
      origin[0],
      origin[1],
      1,
      1,
    );
    gl.uniform4fv(u.u_projection_clipping_plane, data.clippingPlane);
    gl.uniform1f(u.u_projection_transition, data.projectionTransition);
  }
}

/**
 * The world copies to draw the points of a layer in, from `xs[0]` to
 * `xs[1]` in Mercator x, each as the whole worlds they are moved east by.
 * MapLibre hands a custom layer the matrix of world 0 alone, and wraps the
 * map's centre back into it as it is dragged, so on the flat map points
 * drawn there only went missing beside the antimeridian: flights at -179
 * seen from 179, and the far side of a flight across it. So they are drawn
 * in every copy the view shows some of, as MapLibre draws its own layers,
 * the view widened by a quarter each way for the glow of a point beyond
 * its edge, and only in the worlds MapLibre draws (drawnWorlds); the globe
 * has the one.
 */
export function worldCopies(
  map: MapLibreMap,
  options: CustomRenderMethodInput,
  [west, east]: readonly [number, number],
): number[] {
  if (options.shaderData.define.includes("GLOBE")) return [0];
  const [first, last] = drawnWorlds(map);
  const bounds = map.getBounds();
  const left = mercatorX(bounds.getWest());
  const right = mercatorX(bounds.getEast());
  const pad = (right - left) / 4;
  const copies: number[] = [];
  const from = Math.max(Math.ceil(left - pad - east), first);
  const to = Math.min(Math.floor(right + pad - west), last);
  // || 0: not -0, for a first copy rounded up from below 0
  for (let copy = from || 0; copy <= to; copy++) copies.push(copy);
  return copies;
}

/**
 * The first and the last world copy MapLibre draws on the flat map: three
 * either side of world 0 (coveringTiles), and world 0 alone without
 * renderWorldCopies. Unbounded, a pitch of 85 at the least zoom gave 36
 * copies on a wide screen, each a draw of every stretch.
 */
export function drawnWorlds(map: MapLibreMap): [number, number] {
  return map.getRenderWorldCopies() ? [-3, 3] : [0, 0];
}

/**
 * Set the u_depth both layers' shaders read: what the projection makes of
 * a distance from the camera (w) for the depth, the nearest a point may
 * be, and the focal length in pixels of a drawing buffer `height` high
 */
export function setDepth(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  options: CustomRenderMethodInput,
  height: number,
): void {
  const projection = options.projectionMatrix;
  gl.uniform4f(
    location,
    projection[10],
    projection[14],
    options.nearZ,
    focalLengthPx(height, options.fov),
  );
}

/**
 * The state both layers draw in, with a blend function of their own:
 * behind what is nearer of the map without hiding it. MapLibre sets the
 * rest before it hands a 3D custom layer the context, and marks it all to
 * be set again after (see drawCustom in its src/webgl/draw/draw_custom.ts):
 * no vertex array bound, blended, the depth test on, neither culled nor
 * stencilled, and the depth mask on, which is the one to take off.
 */
export function drawing(gl: WebGL2RenderingContext): void {
  gl.depthMask(false);
}

/**
 * Put `layer` on the map right below the first of `below` it has, or on
 * top without any, or move it back there when it is `on` the map already:
 * a new base style keeps the layer, which is none it knows of, but not
 * necessarily where it was
 */
export function placeBelow(
  map: MapLibreMap,
  layer: CustomLayerInterface,
  on: boolean,
  below: readonly string[],
): void {
  const before = below.find((id) => map.getLayer(id));
  if (!on) {
    map.addLayer(layer, before);
    return;
  }
  if (!before) return;
  const order = map.getLayersOrder();
  if (order.indexOf(layer.id) !== order.indexOf(before) - 1) {
    map.moveLayer(layer.id, before);
  }
}

/** Metres a Mercator unit spans at the latitude `lat` on MapLibre's sphere */
export function mercatorUnitMetres(lat: number): number {
  return (
    2 * Math.PI * MAPLIBRE_EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)
  );
}

/**
 * The matrix that takes a point of the cloud, as x and y from `origin` in
 * Mercator units and a height in metres, to where `mercator` takes a point
 * in Mercator units with a height in Mercator units at the latitude `lat`
 * (see getProjectionDataForCustomLayer): `mercator` moved to the origin
 * and its heights scaled to metres, in 64 bits, then as 32. Written into
 * `out`, which the layers hand it again on every frame they draw.
 */
export function cloudMatrix(
  mercator: ArrayLike<number>,
  origin: readonly [number, number],
  lat: number,
  out = new Float32Array(16),
): Float32Array {
  const [x, y] = origin;
  const metre = 1 / mercatorUnitMetres(lat);
  const m = mercator;
  for (let row = 0; row < 4; row++) {
    out[row] = m[row]!;
    out[4 + row] = m[4 + row]!;
    out[8 + row] = m[8 + row]! * metre;
    out[12 + row] = m[row]! * x + m[4 + row]! * y + m[12 + row]!;
  }
  return out;
}
