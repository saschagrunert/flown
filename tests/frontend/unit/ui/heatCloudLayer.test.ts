/**
 * The custom layer of the heat cloud, with the WebGL context mocked: what it
 * makes, when, what it draws, and what it lets go of; its shadow, its
 * pulses, the marks of the way flown that take over from them, and its
 * exposure.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import {
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "../../../../flown/frontend/ui/heatCloudLayer";
import {
  CLOUD_STOPS,
  cloudExposure,
  cloudLook,
  cloudPulse,
  markStrength,
} from "../../../../flown/frontend/ui/heatCloudShaders";
import { cloudMatrix } from "../../../../flown/frontend/ui/glLayer";
import { mercatorOf } from "../../../../flown/frontend/utils/mercator";
import {
  cloudPoints,
  type CloudPoints,
} from "../../../../flown/frontend/calculations/heatCloud";
import { smoothFlights } from "../../../../flown/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../flown/frontend/types";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("../../../../flown/frontend/utils/motion", () => ({
  prefersReducedMotion: () => motion.reduced,
}));

/** Whether withMapStill is capturing the map */
const capture = vi.hoisted(() => ({ still: false }));
vi.mock(
  "../../../../flown/frontend/utils/mapHelpers",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isMapStill: () => capture.still,
  }),
);

/** A WebGL2 context that records what is asked of it */
function mockGl(compiles = true) {
  let objects = 0;
  const made = (kind: string) => vi.fn(() => ({ kind, n: objects++ }));
  const gl = {
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    BLEND: 8,
    ONE: 9,
    ONE_MINUS_SRC_COLOR: 10,
    ONE_MINUS_SRC_ALPHA: 11,
    DEPTH_TEST: 12,
    CULL_FACE: 13,
    STENCIL_TEST: 14,
    TRIANGLE_STRIP: 15,
    MAX: 16,
    FUNC_ADD: 17,
    CONSTANT_COLOR: 18,
    createBuffer: made("buffer"),
    createVertexArray: made("vao"),
    createProgram: made("program"),
    createShader: made("shader"),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => compiles),
    getShaderInfoLog: vi.fn(() => "ERROR: 0:1: nonsense"),
    attachShader: vi.fn(),
    deleteShader: vi.fn(),
    bindAttribLocation: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ""),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    vertexAttribDivisor: vi.fn(),
    useProgram: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4f: vi.fn(),
    uniform4fv: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    blendFuncSeparate: vi.fn(),
    blendEquation: vi.fn(),
    blendColor: vi.fn(),
    depthMask: vi.fn(),
    drawArraysInstanced: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteProgram: vi.fn(),
    isProgram: vi.fn(() => true),
    isContextLost: vi.fn(() => false),
  };
  return gl;
}

type MockGl = ReturnType<typeof mockGl>;

/** What MapLibre hands a custom layer for a frame, in Mercator or on the globe */
function frame(globe = false): CustomRenderMethodInput {
  const identity = new Float64Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  const projection = new Float64Array(identity);
  projection[10] = -1.01;
  projection[14] = -2.5;
  return {
    farZ: 1000,
    nearZ: 1,
    fov: 0.6435,
    modelViewProjectionMatrix: identity,
    projectionMatrix: projection,
    shaderData: {
      variantName: globe ? "globe" : "mercator",
      vertexShaderPrelude: "uniform mat4 u_projection_matrix;",
      define: globe ? "#define GLOBE" : "",
    },
    defaultProjectionData: {
      mainMatrix: new Float64Array(identity),
      fallbackMatrix: new Float64Array(identity),
      tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [1, 0, 0, 0],
      projectionTransition: globe ? 1 : 0,
      clipAntimeridian: false,
    },
    getProjectionData: vi.fn(),
  } as unknown as CustomRenderMethodInput;
}

function mockMap(): MapLibreMap & {
  triggerRepaint: Mock;
  getBounds: Mock;
  emit: (type: string) => void;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on: vi.fn((type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    off: vi.fn((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    emit: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    getCenter: vi.fn(() => ({ lng: 11, lat: 47 })),
    // A view a degree either side of the centre, the flat map's (see
    // worldCopies)
    getRenderWorldCopies: vi.fn(() => true),
    getBounds: vi.fn(function (this: MapLibreMap) {
      const { lng } = this.getCenter();
      return { getWest: () => lng - 1, getEast: () => lng + 1 };
    }),
    getZoom: vi.fn(() => 8),
    getPixelRatio: vi.fn(() => 2),
    getCenterElevation: vi.fn(() => 500),
    triggerRepaint: vi.fn(),
  } as unknown as MapLibreMap & {
    triggerRepaint: Mock;
    getBounds: Mock;
    emit: (type: string) => void;
  };
}

/** Points of a flight of five fixes, a stretch between each */
function points(): CloudPoints {
  const fixes: [number, number][] = [0, 1, 2, 3, 4].map((i) => [
    47,
    11 + i * 0.01,
  ]);
  const segments: PathSegment[] = fixes.slice(1).map((to, i) => ({
    path_id: 1,
    coords: [fixes[i]!, to],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    time: i * 5,
  }));
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 0,
  });
  return cloudPoints(segments, flights, () => true, 11);
}

const STYLE: HeatCloudStyle = {
  groundM: 3,
  liftM: 3,
  opacity: 1,
  flow: true,
};

/** The draws of a frame of STYLE: the shadow, then the glow */
const PASSES = 2;

describe("the heat cloud's layer", () => {
  let gl: MockGl;
  let map: ReturnType<typeof mockMap>;
  let style: HeatCloudStyle | null;
  let failed: Mock;
  let layer: HeatCloudLayer;

  const render = (options = frame()): void =>
    layer.render(gl as unknown as WebGL2RenderingContext, options);

  /** What performance.now says, in milliseconds */
  let now: number;

  /** Every value given to a uniform, with its place in the calls */
  const given = (): [name: string, at: number, values: number[]][] =>
    [gl.uniform1f, gl.uniform2f, gl.uniform3f, gl.uniform4f].flatMap((fn) =>
      fn.mock.calls.map(
        (call, k) =>
          [
            (call[0] as { name: string }).name,
            fn.mock.invocationCallOrder[k]!,
            call.slice(1) as number[],
          ] as [string, number, number[]],
      ),
    );

  /** The value the uniform `name` was last given before the call `before` */
  const uniform = (name: string, before = Infinity): number[] => {
    let last = -1;
    let value: number[] = [];
    for (const [of, at, values] of given()) {
      if (of === name && at < before && at > last) {
        last = at;
        value = values;
      }
    }
    return value;
  };

  /** The values the uniform `name` had in the draws of the last frame */
  const perDraw = (name: string): number[][] =>
    gl.drawArraysInstanced.mock.invocationCallOrder
      .slice(-PASSES)
      .map((draw) => uniform(name, draw));

  beforeEach(() => {
    gl = mockGl();
    map = mockMap();
    style = STYLE;
    failed = vi.fn();
    motion.reduced = false;
    capture.still = false;
    now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    layer = new HeatCloudLayer(() => style, failed);
  });

  /** The sources of the shaders compiled last */
  const shaderSource = (of: string): string =>
    gl.shaderSource.mock.calls
      .map(([, source]) => source as string)
      .filter((source) => source.includes(of))
      .at(-1)!;
  const vertexSource = (): string => shaderSource("projectTileFor3D");
  const fragmentSource = (): string => shaderSource("fragColor");

  /** Draw a frame, and how many frames it asks for after it */
  const asks = (): number => {
    map.triggerRepaint.mockClear();
    now += 16;
    render();
    return map.triggerRepaint.mock.calls.length;
  };

  it("is a 3D custom layer of its own id", () => {
    expect(layer.id).toBe(HEAT_CLOUD_LAYER);
    expect(layer.type).toBe("custom");
    expect(layer.renderingMode).toBe("3d");
  });

  it("makes nothing in the context as it is added, where MapLibre does not expect it", () => {
    layer.onAdd(map);
    for (const [name, fn] of Object.entries(gl)) {
      if (typeof fn === "function") expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it("draws nothing without points, or where the app says not to", () => {
    layer.onAdd(map);
    render();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();

    layer.setPoints(points());
    style = null;
    render();
    style = { ...STYLE, opacity: 0 };
    render();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(layer.frames).toBe(0);
    expect(layer.drawn).toBe(0);
  });

  it("draws in every world copy the flat map shows, and none it does not", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    // A view from 10 W to 12 E a world further east: the flights drawn in
    // world 0 and in the copy east of it, the last from an origin a world
    // east
    const [mx, my] = mercatorOf([47, 11]);
    map.getBounds.mockReturnValueOnce({
      getWest: () => -10,
      getEast: () => 372,
    });
    render();
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(2 * PASSES);
    // Pass by pass, each in both copies: the shadows of both before either
    // glow, which a later shadow's MAX would darken
    const draws = gl.drawArraysInstanced.mock.invocationCallOrder;
    const blends = gl.blendEquation.mock.invocationCallOrder;
    /** The blend equation last set before the call `draw` */
    const blendAt = (draw: number): unknown =>
      gl.blendEquation.mock.calls[
        blends.filter((call) => call < draw).length - 1
      ]![0];
    expect(draws.map(blendAt)).toEqual([
      gl.MAX,
      gl.MAX,
      gl.FUNC_ADD,
      gl.FUNC_ADD,
    ]);
    const centres = draws.map((draw) => uniform("u_centre", draw));
    for (const [k, copy] of [0, 1, 0, 1].entries()) {
      expect(centres[k]![0]).toBeCloseTo(mx - cloud.origin[0] - copy, 9);
      expect(centres[k]![1]).toBeCloseTo(my - cloud.origin[1], 9);
    }

    gl.drawArraysInstanced.mockClear();
    map.getBounds.mockReturnValueOnce({
      getWest: () => 100,
      getEast: () => 110,
    });
    render();
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(layer.drawn).toBe(0);

    // The globe has the one
    map.getBounds.mockReturnValueOnce({
      getWest: () => 100,
      getEast: () => 110,
    });
    render(frame(true));
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("asks the map for a frame as it gets new points", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    expect(map.triggerRepaint).toHaveBeenCalled();
  });

  it("draws a quad per stretch, as a screen and without writing the depth, and counts it", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    render();

    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
    expect(gl.drawArraysInstanced).toHaveBeenLastCalledWith(
      gl.TRIANGLE_STRIP,
      0,
      4,
      cloud.count - 1,
    );
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(
      gl.CONSTANT_COLOR,
      gl.ONE_MINUS_SRC_COLOR,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    // Towards white at full strength, as ONE would
    expect(gl.blendColor).toHaveBeenCalledWith(1, 1, 1, 1);
    // The glow is added up, after the shadow's brightest is kept
    expect(gl.blendEquation).toHaveBeenLastCalledWith(gl.FUNC_ADD);
    // Against the depth without writing it. The rest of the state, and
    // putting it back after, is MapLibre's (see drawing)
    expect(gl.depthMask).toHaveBeenCalledWith(false);
    expect(gl.depthMask).not.toHaveBeenCalledWith(true);
    expect(gl.enable).not.toHaveBeenCalled();
    expect(layer.frames).toBe(1);
    expect(layer.drawn).toBe(cloud.count - 1);
  });

  it("makes its buffers and compiles its shaders once, and uploads the points once", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    render();
    render();
    render();

    expect(gl.createVertexArray).toHaveBeenCalledOnce();
    expect(gl.createProgram).toHaveBeenCalledOnce();
    const uploads = gl.bufferData.mock.calls.filter(
      ([, data]) => data === cloud.points,
    );
    expect(uploads).toHaveLength(1);

    const next = points();
    layer.setPoints(next);
    render();
    expect(
      gl.bufferData.mock.calls.filter(([, data]) => data === next.points),
    ).toHaveLength(1);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(4 * PASSES);
  });

  it("lets go of the points it drew in the frame after it is given none, on the map or not", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    gl.bufferData.mockClear();

    layer.setPoints(null);
    render();

    expect(gl.bufferData).toHaveBeenCalledExactlyOnceWith(
      gl.ARRAY_BUFFER,
      0,
      gl.STATIC_DRAW,
    );
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
    render();
    expect(gl.bufferData).toHaveBeenCalledOnce();
  });

  it("builds its vertex shader on MapLibre's prelude for the projection, and a program per projection", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render(frame(false));
    render(frame(true));
    render(frame(true));

    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const vertexSources = gl.shaderSource.mock.calls
      .map(([, source]) => source as string)
      .filter((source) => source.includes("projectTileFor3D"));
    expect(vertexSources).toHaveLength(2);
    for (const source of vertexSources) {
      expect(
        source.startsWith("#version 300 es\nuniform mat4 u_projection_matrix;"),
      ).toBe(true);
    }
    expect(vertexSources[1]).toContain("#define GLOBE");
  });

  it("hands the globe its own matrix, and the flat map's for the way into it", () => {
    const cloud = points();
    layer.onAdd(map);
    layer.setPoints(cloud);
    render(frame(true));

    const matrices = new Map(
      gl.uniformMatrix4fv.mock.calls.map(([location, , matrix]) => [
        (location as { name: string }).name,
        matrix as Float32Array,
      ]),
    );
    expect([...matrices.get("u_projection_matrix")!]).toEqual([
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    expect(matrices.get("u_projection_fallback_matrix")).toBeDefined();
    expect(gl.uniform4f).toHaveBeenCalledWith(
      { name: "u_projection_tile_mercator_coords" },
      cloud.origin[0],
      cloud.origin[1],
      1,
      1,
    );
  });

  it("gives up on shaders that do not compile, says so once, and leaves the map as it is", () => {
    gl = mockGl(false);
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    render();

    expect(failed).toHaveBeenCalledOnce();
    expect(String(failed.mock.calls[0]![0])).toContain("did not compile");
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(gl.createShader).toHaveBeenCalledOnce();
  });

  it("lets go of its buffers as it is removed, and keeps its program for its return", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledOnce();
    expect(gl.deleteProgram).not.toHaveBeenCalled();

    // Back with the 3D view, in the same context
    layer.onAdd(map);
    render();
    expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledOnce();
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(2 * PASSES);
  });

  it("compiles its shaders anew where the context was lost while it was off the map", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    // Restored as the same object, without the programs of before
    gl.isProgram.mockReturnValue(false);
    layer.onAdd(map);
    render();

    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(2 * PASSES);
  });

  it("tries shaders that did not compile again once it is back on the map, and says so again where they still do not", () => {
    gl = mockGl(false);
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    expect(failed).toHaveBeenCalledOnce();
    // Taken off the map for it (ui/heatCloud.ts), and put back after a
    // loss and restore it did not hear of: the same context object
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    layer.onAdd(map);
    render();
    expect(failed).toHaveBeenCalledTimes(2);

    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    gl.getShaderParameter.mockReturnValue(true);
    layer.onAdd(map);
    render();
    expect(failed).toHaveBeenCalledTimes(2);
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("does not touch a context that was lost", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    gl.isContextLost.mockReturnValue(true);
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
  });

  it("tells of no failure while its context is lost, where nothing can be made, and makes it all once the context is back", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    gl.isContextLost.mockReturnValue(true);
    gl.createBuffer.mockReturnValue(null as never);
    render();
    expect(failed).not.toHaveBeenCalled();

    gl.isContextLost.mockReturnValue(false);
    gl.createBuffer.mockImplementation(() => ({ kind: "buffer", n: -1 }));
    render();
    // A program the lost context could not compile is compiled anew
    gl.isContextLost.mockReturnValue(true);
    gl.getShaderParameter.mockReturnValue(null as never);
    render(frame(true));
    expect(failed).not.toHaveBeenCalled();
    gl.isContextLost.mockReturnValue(false);
    gl.getShaderParameter.mockReturnValue(true);
    gl.drawArraysInstanced.mockClear();
    render(frame(true));
    expect(failed).not.toHaveBeenCalled();
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("makes everything anew in the context MapLibre gets back after a loss, which is the same object", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    // MapLibre removes the layer with the style of before, while the
    // context is already lost, and the app adds it again to the one it
    // gets back (see ui/heatCloud.ts)
    gl.isContextLost.mockReturnValue(true);
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    gl.isContextLost.mockReturnValue(false);
    expect(gl.deleteBuffer).not.toHaveBeenCalled();
    gl.createVertexArray.mockClear();
    gl.createProgram.mockClear();
    gl.drawArraysInstanced.mockClear();
    layer.onAdd(map);
    render();

    expect(gl.createVertexArray).toHaveBeenCalledOnce();
    expect(gl.createProgram).toHaveBeenCalledOnce();
    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("makes everything anew in another context", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    const other = mockGl();
    layer.render(other as unknown as WebGL2RenderingContext, frame());

    expect(other.createVertexArray).toHaveBeenCalledOnce();
    expect(other.createProgram).toHaveBeenCalledOnce();
    expect(other.bufferData).toHaveBeenCalled();
    expect(other.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("does not take the programs it kept into another context", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    layer.onAdd(map);
    const other = mockGl();
    layer.render(other as unknown as WebGL2RenderingContext, frame());

    expect(other.isProgram).not.toHaveBeenCalled();
    expect(other.createProgram).toHaveBeenCalledOnce();
    expect(other.drawArraysInstanced).toHaveBeenCalledTimes(PASSES);
  });

  it("reads the heat, the time and the marks of a stretch's ends from the seven floats of each point", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    const stride = 7 * 4;
    const pointers = gl.vertexAttribPointer.mock.calls
      .slice(1)
      .map((call) => call as unknown as number[]);
    // Before, start, end and after, and a float or three past each of the
    // first three: the heat into the start, and the heat, the time and the
    // marks at either end of the stretch
    expect(
      pointers.map(([location, size, , , step, offset]) => [
        location,
        size,
        step,
        offset,
      ]),
    ).toEqual([
      [1, 4, stride, 0],
      [2, 1, stride, 16],
      [3, 4, stride, stride],
      [4, 3, stride, stride + 16],
      [5, 4, stride, 2 * stride],
      [6, 3, stride, 2 * stride + 16],
      [7, 4, stride, 3 * stride],
    ]);
  });

  it("draws a faint shadow on the ground under the lifted flights, then their glow", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();

    const [shadow, glow] = perDraw("u_heights");
    expect(shadow).toEqual([STYLE.groundM, 0]);
    expect(glow).toEqual([STYLE.groundM, STYLE.liftM]);
    // Muted, filling slower and not near as far
    const [shadowColour, glowColour] = perDraw("u_colour");
    const [r, g, b] = shadowColour!;
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThan(0.15);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(glowColour![2]!);
    const [shadowCeiling, glowCeiling] = perDraw("u_ceiling").map(([c]) => c);
    expect(shadowCeiling).toBeLessThan(0.5);
    expect(glowCeiling).toBe(1);
    // Cast from some height above the ground on, the glow at every height
    const [[from, to], [none, all]] = perDraw("u_shadow") as [
      number[],
      number[],
    ];
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from!);
    expect([none, all]).toEqual([0, 0]);
    // No pulses in the shadow
    expect(perDraw("u_flowMix")[0]![1]).toBe(0);
  });

  it("draws the heat up to the clock of the replay of all flights, and all of it without", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    expect(perDraw("u_until")).toEqual([[1e30], [1e30]]);

    style = { ...STYLE, until: 7 };
    render();

    expect(perDraw("u_until")).toEqual([[7], [7]]);
    const vertex = vertexSource();
    // A stretch not begun is left out, one under way cut where the clock
    // is, with no join to the next at the cut, and its heat and ends those
    // of the part flown
    expect(vertex).toContain("a_heat.y >= u_until");
    expect(vertex).toContain(
      "float flown = a_out.y > u_until ? (u_until - a_heat.y) / (a_out.y - a_heat.y) : 1.0;",
    );
    expect(vertex).toContain("vec4 b = mix(a, project(a_end), flown);");
    expect(vertex).toContain("vec2 kept = vec2(0.0, flown);");
    expect(vertex).toContain("if (a_out.x > 0.0 && flown >= 1.0) {");
  });

  it("pulls a glow near the ground to the plane 30 ft over its ground, from points 100 px apart", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    for (const zoom of [8, 14]) {
      (map.getZoom as Mock).mockReturnValue(zoom);
      render();
      const [apart, slack] = uniform("u_ground");
      expect(apart).toBeCloseTo(100 / (512 * 2 ** zoom), 15);
      expect(slack).toBeCloseTo(30 * STYLE.groundM, 9);
    }
    // on flat ground (no relief) the plane is the ground itself
    style = { ...STYLE, groundM: 0 };
    render();
    expect(uniform("u_ground")[1]).toBe(0);
    // No nearer than the near plane, nor than halfway to the camera
    expect(vertexSource()).toContain(
      "pulled = max(pulled, max(0.5 * w, near * 1.01));",
    );
  });

  it("keeps the brightest shadow on a pixel rather than adding them up, so they fill no further than their ceiling", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();

    const [shadowDraw, glowDraw] =
      gl.drawArraysInstanced.mock.invocationCallOrder;
    const equations = (gl.blendEquation.mock.calls as number[][]).map(
      ([mode], k): [number, number] => [
        mode!,
        gl.blendEquation.mock.invocationCallOrder[k]!,
      ],
    );
    const before = (draw: number): number | undefined =>
      equations.filter(([, at]) => at < draw).at(-1)?.[0];
    expect(before(shadowDraw!)).toBe(gl.MAX);
    // and puts back the equation MapLibre and the glow draw with
    expect(before(glowDraw!)).toBe(gl.FUNC_ADD);
  });

  it("draws no shadow while it is dimmed, and its glow towards as much of white as it is drawn with", () => {
    style = { ...STYLE, opacity: 0.25 };
    layer.onAdd(map);
    layer.setPoints(points());
    render();

    expect(gl.drawArraysInstanced).toHaveBeenCalledOnce();
    expect(uniform("u_heights")).toEqual([STYLE.groundM, STYLE.liftM]);
    // Each glow moves a pixel by glow * (0.25 - dst), however many there
    // are, rather than by a quarter of its heat, which filled to white
    expect(gl.blendColor).toHaveBeenLastCalledWith(0.25, 0.25, 0.25, 0.25);
    expect(gl.blendFuncSeparate).toHaveBeenLastCalledWith(
      gl.CONSTANT_COLOR,
      gl.ONE_MINUS_SRC_COLOR,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
  });

  it("holds its narrowest blur to a pixel rather than to a part of the widest", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    for (const zoom of [8, 14]) {
      (map.getZoom as Mock).mockReturnValue(zoom);
      render();
      const [sigma, narrowest, widest] = gl.uniform3f.mock.calls
        .filter(
          ([location]) => (location as { name: string }).name === "u_sigma",
        )
        .at(-1)!
        .slice(1) as number[];
      expect(narrowest).toBe(0.8);
      // Close to the camera no wider than half as wide again
      expect(widest).toBeCloseTo(sigma! * 1.5, 9);
    }
  });

  it("fades the glow with its distance from the camera, behind the middle more than in front of it", () => {
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    // The scale of each end is the middle's distance over its own
    const source = vertexSource().replace(/\s+/g, " ");
    expect(source).toContain(
      "scales * min(blurs / sigmas, 1.0) * pow(min(scales, 1.0), vec2(1.50)) * pow(max(scales, 1.0), vec2(-0.60))",
    );
  });

  it("draws no shadow where the flights are drawn on the ground", () => {
    style = { ...STYLE, liftM: 0 };
    layer.onAdd(map);
    layer.setPoints(points());
    render();
    expect(gl.drawArraysInstanced).toHaveBeenCalledOnce();
    expect(uniform("u_heights")).toEqual([STYLE.groundM, 0]);
  });

  describe("the pulses", () => {
    /** Draw frames `ms` apart for `total` milliseconds */
    const frames = (total: number, ms = 16): void => {
      for (let t = 0; t < total; t += ms) {
        now += ms;
        render();
      }
    };
    const strength = (): number => uniform("u_flowMix")[1]!;
    /** Draw frames until the pulses rest, the map unused */
    const rested = (): void => {
      frames(2000);
      frames(30000, 100);
      expect(strength()).toBe(0);
    };

    beforeEach(() => {
      layer.onAdd(map);
      layer.setPoints(points());
    });

    it("fade in and move on along the flights' time, a frame after the other", () => {
      expect(asks()).toBe(1);
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
      expect(strength()).toBeLessThanOrEqual(1);
      const [, , before] = uniform("u_flow");
      now += 16;
      render();
      const [inverse, half, after] = uniform("u_flow");
      // Two periods, one twice the other
      expect(half).toBeCloseTo(inverse! / 2, 12);
      expect(after).not.toBe(before);
      expect(asks()).toBe(1);
    });

    it("ask for the next frame as each is drawn, so they move every frame the screen shows", () => {
      for (let k = 0; k < 3; k++) {
        map.triggerRepaint.mockClear();
        now += 16;
        render();
        // at once, not after a delay that would skip frames
        expect(map.triggerRepaint).toHaveBeenCalledOnce();
      }
    });

    it("move on by the time between frames, and by 100 ms at most after a slow one", () => {
      frames(2000);
      const moved = (ms: number): number => {
        const [inverse, , before] = uniform("u_flow");
        now += ms;
        render();
        const [, , after] = uniform("u_flow");
        // in seconds of the flights, from the phase of the shorter period
        return ((((after! - before!) % 1) + 1) % 1) / inverse!;
      };
      const frame16 = moved(16);
      expect(moved(32)).toBeCloseTo(2 * frame16, 9);
      expect(moved(1000)).toBeCloseTo(moved(100), 9);
    });

    it("keep their phase as the zoom hands over from one period to the next", () => {
      frames(2000);
      let last: { flow: number[]; mix: number } | null = null;
      let handovers = 0;
      // Out, where the periods get longer; no time passes, only the zoom
      for (let zoom = 10; zoom > 8; zoom -= 0.004) {
        (map.getZoom as Mock).mockReturnValue(zoom);
        render();
        const flow = uniform("u_flow");
        const mix = uniform("u_flowMix")[0]!;
        if (last && flow[0]! !== last.flow[0]!) {
          handovers++;
          // The longer period drawn last is the shorter one drawn now, at
          // the same phase, and the blend moves from all of it to all of it
          expect(flow[0]).toBeCloseTo(last.flow[1]!, 12);
          expect(flow[2]).toBeCloseTo(last.flow[3]!, 12);
          expect(last.mix).toBeGreaterThan(0.99);
          expect(mix).toBeLessThan(0.01);
        }
        last = { flow, mix };
      }
      expect(handovers).toBeGreaterThan(0);
    });

    it("fade out and ask for no frame once the map has not been used for a while, and run again as it is", () => {
      frames(2000);
      frames(5000, 100);
      // Still running 7 s on
      expect(strength()).toBeGreaterThan(0.5);
      frames(4000, 100);
      expect(strength()).toBe(0);
      expect(asks()).toBe(0);

      map.triggerRepaint.mockClear();
      map.emit("move");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      // Once is enough until they rest again
      map.emit("move");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("keep running while the map is used", () => {
      for (let k = 0; k < 40; k++) {
        frames(1000, 100);
        map.emit("move");
      }
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("are not woken by the pointer moving over the map, which kept it drawing every frame", () => {
      rested();
      map.triggerRepaint.mockClear();
      map.emit("mousemove");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
      expect(map.on).not.toHaveBeenCalledWith(
        "mousemove",
        expect.any(Function),
      );
      expect(asks()).toBe(0);
      expect(strength()).toBe(0);
      // A touch does
      map.emit("touchstart");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
    });

    it("do not run under reduced motion, nor where the app says not to, and ask for no frame", () => {
      for (const [reduced, flow] of [
        [true, true],
        [false, false],
      ] as const) {
        motion.reduced = reduced;
        style = { ...STYLE, flow };
        frames(500);
        expect(strength()).toBe(0);
        expect(asks()).toBe(0);
        // Nor for the map as it is used
        map.triggerRepaint.mockClear();
        map.emit("move");
        expect(map.triggerRepaint).not.toHaveBeenCalled();
      }
    });

    it("start again as the map is used once reduced motion is turned off", () => {
      motion.reduced = true;
      frames(500);
      map.triggerRepaint.mockClear();
      map.emit("move");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
      motion.reduced = false;
      map.emit("move");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("stop the frames when the cloud is not drawn", () => {
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
      style = null;
      expect(asks()).toBe(0);
      map.triggerRepaint.mockClear();
      map.emit("move");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
    });

    it("hold still in the frame an export takes, and run on after it", () => {
      frames(2000);
      expect(strength()).toBeGreaterThan(0.5);
      capture.still = true;
      now += 16;
      render();
      expect(strength()).toBe(0);
      capture.still = false;
      now += 16;
      render();
      expect(strength()).toBeGreaterThan(0.5);
    });

    it("are not woken by the resizes of an export", () => {
      rested();
      capture.still = true;
      map.triggerRepaint.mockClear();
      map.emit("move");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
      expect(asks()).toBe(0);
      capture.still = false;
      expect(asks()).toBe(0);
      expect(strength()).toBe(0);
    });

    it("let go of the map as the layer is removed", () => {
      layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
      expect(map.off).toHaveBeenCalledWith("touchstart", expect.any(Function));
      expect(map.off).toHaveBeenCalledWith("move", expect.any(Function));
      map.triggerRepaint.mockClear();
      map.emit("move");
      expect(map.triggerRepaint).not.toHaveBeenCalled();
    });

    it("are drawn in the glow as cloudPulse has them, and never in the shadow", () => {
      render();
      expect(fragmentSource()).toContain(
        "return (1.0 - cos(6.2831853 * phase * phase)) * 1.3229730;",
      );
      expect(vertexSource()).toContain("v_flow = shadow ? 0.0 : smoothstep(");
    });
  });

  describe("the marks of the way flown", () => {
    /** Draw frames `ms` apart for `total` milliseconds */
    const frames = (total: number, ms = 16): void => {
      for (let t = 0; t < total; t += ms) {
        now += ms;
        render();
      }
    };
    /** How strongly the last frame drew the marks, and the pulses */
    const marks = (): number => uniform("u_marks")[0]!;
    const pulses = (): number => uniform("u_flowMix")[1]!;

    beforeEach(() => {
      // Where they are drawn in full (see CLOUD_MARK_ZOOMS)
      (map.getZoom as Mock).mockReturnValue(9);
      layer.onAdd(map);
      layer.setPoints(points());
    });

    it("show in full under reduced motion, in the glow and not in its shadow", () => {
      motion.reduced = true;
      frames(500);
      const [shadow, glow] = perDraw("u_marks");
      expect(shadow![0]).toBe(0);
      expect(glow![0]).toBe(1);
      expect(pulses()).toBe(0);
      expect(layer.marks).toBe(1);
      expect(layer.pulses).toBe(0);
    });

    it("are spaced in CSS pixels, and sized by them, whatever the screen's pixels", () => {
      motion.reduced = true;
      render();
      const [, spacing, ratio] = uniform("u_marks");
      expect(ratio).toBe(2);
      expect(spacing! / ratio!).toBeGreaterThan(30);
      expect(spacing! / ratio!).toBeLessThan(120);
    });

    it("hand over to the pulses as they fade in, and take over again as they fade out, one of the two at a time", () => {
      const seen: [marks: number, pulses: number][] = [];
      const watch = (total: number, ms: number): void => {
        for (let t = 0; t < total; t += ms) {
          now += ms;
          render();
          seen.push([layer.marks, layer.pulses]);
        }
      };
      watch(2000, 16);
      expect(layer.pulses).toBe(1);
      expect(layer.marks).toBe(0);
      expect(marks()).toBe(0);
      // Resting after a while without the map being used
      watch(30000, 100);
      expect(layer.pulses).toBe(0);
      expect(layer.marks).toBe(1);
      expect(marks()).toBe(1);
      for (const [shown, running] of seen) {
        expect(shown + running).toBeCloseTo(1, 12);
      }
      // Some frames on the way drew some of both
      expect(seen.some(([shown]) => shown > 0.2 && shown < 0.8)).toBe(true);
    });

    it("show while a replay runs, where the pulses do not", () => {
      style = { ...STYLE, flow: false };
      frames(500);
      expect(marks()).toBe(1);
      expect(pulses()).toBe(0);
    });

    it("show in a still image of the map in place of a pulse caught in the middle, for that frame only", () => {
      frames(2000);
      expect(layer.pulses).toBe(1);
      capture.still = true;
      now += 16;
      render();
      expect(marks()).toBe(1);
      expect(pulses()).toBe(0);
      capture.still = false;
      now += 16;
      render();
      expect(marks()).toBe(0);
      expect(pulses()).toBeGreaterThan(0.5);
    });

    it("fade out towards a view of a region, where the routes run together", () => {
      motion.reduced = true;
      (map.getZoom as Mock).mockReturnValue(5);
      render();
      expect(marks()).toBe(0);
      (map.getZoom as Mock).mockReturnValue(9);
      render();
      expect(marks()).toBe(1);
    });

    it("come from their own block of the shaders, before the pulses", () => {
      render();
      const source = (of: string): string =>
        gl.shaderSource.mock.calls
          .map(([, text]) => String(text))
          .find((text) => text.includes(of))!;
      const vertex = source("projectTileFor3D");
      expect(vertex).toContain(
        "v_marks = mix(vec2(a_heat.z), vec2(a_out.z), kept);",
      );
      // What the mirror of the shaders below stands for: the one axis
      // nearest the stretch, the lattice from the part of the stretch in
      // front of the near plane, and the chevron
      expect(vertex).toContain(
        "return floor(atan(d.y, d.x) / 0.39269908 + 0.5);",
      );
      // A stretch whose neighbour takes another axis fades its marks out
      // towards their join, where each would draw a mark of its own
      expect(vertex).toContain(
        "if (a_in > 0.0 && mod(markAxis(a_before.xy, a_start.xy) - axis, 8.0) != 0.0) v_marks.x = 0.0;",
      );
      expect(vertex).toContain(
        "if (a_out.x > 0.0 && mod(markAxis(a_end.xy, a_after.xy) - axis, 8.0) != 0.0) v_marks.y = 0.0;",
      );
      expect(vertex).toContain(
        "vec4(mix(a_start.xy, a_end.xy, kept.x), mix(a_start.xy, a_end.xy, kept.y))",
      );
      const fragment = source("fragColor");
      expect(fragment).toContain("uniform vec3 u_marks;");
      expect(fragment).toContain(
        "abs(ahead - 0.4 * size + 0.8 * abs(across)) * 0.78086881",
      );
      const main = fragment.slice(fragment.indexOf("void main()"));
      expect(main.indexOf("marked(glow")).toBeGreaterThan(0);
      expect(main.indexOf("marked(glow")).toBeLessThan(
        main.indexOf("if (u_flowMix.y * v_flow > 0.0)"),
      );
    });
  });

  describe("the exposure", () => {
    const gainOf = (cloud: CloudPoints): number => {
      const fresh = new HeatCloudLayer(() => ({ ...STYLE, liftM: 0 }), failed);
      fresh.onAdd(map);
      fresh.setPoints(cloud);
      gl.uniform1f.mockClear();
      fresh.render(gl as unknown as WebGL2RenderingContext, frame());
      return uniform("u_gain")[0]!;
    };

    it("follows the busiest heat of the points", () => {
      const cloud = { ...points(), busiest: 100 / 51.4 };
      const busy = { ...cloud, busiest: 200 / 51.4 };
      expect(gainOf(busy) / gainOf(cloud)).toBeCloseTo(0.5, 9);
    });

    it("darkens the busiest cells no further than white at the gain of the zoom", () => {
      const light = { ...points(), busiest: 10 / 51.4 };
      const busy = { ...light, busiest: 200 / 51.4 };
      const out = [gainOf(light), gainOf(busy)];
      (map.getZoom as Mock).mockReturnValue(13);
      const closer = [gainOf(light), gainOf(busy)];
      // Five zooms in a pixel is 32 times shorter, at half the gain: a light
      // cloud dims with it, the busiest cells stay as white as further out
      expect(closer[0]! / out[0]!).toBeCloseTo(16, 6);
      expect(closer[1]! / out[1]!).toBeCloseTo(32, 6);
    });

    it("eases to that of new points, and asks for no frame once there", () => {
      motion.reduced = true;
      style = { ...STYLE, liftM: 0 };
      const cloud = { ...points(), busiest: 200 / 51.4 };
      layer.onAdd(map);
      layer.setPoints(cloud);
      render();
      const first = uniform("u_gain")[0]!;
      layer.setPoints({ ...cloud, busiest: cloud.busiest / 2 });
      now += 16;
      render();
      const eased = uniform("u_gain")[0]!;
      const target = first * 2;
      expect(eased).toBeGreaterThan(first);
      expect(eased).toBeLessThan(target);
      expect(asks()).toBe(1);
      for (let k = 0; k < 100; k++) {
        now += 16;
        render();
      }
      expect(uniform("u_gain")[0]! / target).toBeCloseTo(1, 1);
      expect(asks()).toBe(0);
    });

    it("scales the heat by the fade, and asks for every frame while it fades", () => {
      motion.reduced = true;
      style = { ...STYLE, liftM: 0 };
      layer.onAdd(map);
      layer.setPoints(points());
      for (let k = 0; k < 100; k++) {
        now += 16;
        render();
      }
      const full = uniform("u_gain")[0]!;
      expect(asks()).toBe(0);
      style = { ...STYLE, liftM: 0, fade: 0.25 };
      expect(asks()).toBe(1);
      expect(uniform("u_gain")[0]! / full).toBeCloseTo(0.25, 9);
    });
  });
});

describe("cloudPulse", () => {
  /** Its mean over a period, by the midpoint rule */
  const mean = (steps = 100000): number => {
    let sum = 0;
    for (let k = 0; k < steps; k++) sum += cloudPulse((k + 0.5) / steps);
    return sum / steps;
  };

  it("is 1 on average, so the pulses leave the heat as bright as it is", () => {
    expect(mean()).toBeCloseTo(1, 6);
  });

  it("hands over to the next pulse without a step or a kink", () => {
    const h = 1e-4;
    expect(cloudPulse(0)).toBe(0);
    expect(cloudPulse(1)).toBeCloseTo(0, 12);
    // its slope is 0 at either end of the period
    expect(cloudPulse(h) / h).toBeLessThan(1e-6);
    expect(cloudPulse(1 - h) / h).toBeLessThan(0.02);
  });

  it("falls ahead of its head quicker than it rises behind it, but no steeper than the comet before", () => {
    let head = 0;
    let steepest = 0;
    const steps = 10000;
    for (let k = 1; k <= steps; k++) {
      const [x0, x1] = [(k - 1) / steps, k / steps];
      if (cloudPulse(x1) > cloudPulse(head)) head = x1;
      steepest = Math.max(
        steepest,
        Math.abs(cloudPulse(x1) - cloudPulse(x0)) * steps,
      );
    }
    // The head is ahead, where the flights went on to: the tail behind it
    // is more than twice as long as its front
    expect(head).toBeCloseTo(Math.SQRT1_2, 3);
    // x^2 (1 - smoothstep(0.85, 1, x)) * 3.776 fell at 27 a period
    expect(steepest).toBeLessThan(15);
    expect(cloudPulse(head)).toBeLessThan(2.7);
  });
});

describe("markStrength", () => {
  it("is the part of the pulses that does not show, so the cloud shows one of the two", () => {
    expect(markStrength(0, 10)).toBe(1);
    expect(markStrength(1, 10)).toBe(0);
    expect(markStrength(0.25, 10)).toBeCloseTo(0.75, 12);
    // Within 0 and 1 whatever it is asked
    expect(markStrength(-1, 10)).toBe(1);
    expect(markStrength(2, 10)).toBe(0);
  });

  it("fades in from a view of a region to one of its routes", () => {
    expect(markStrength(0, 5)).toBe(0);
    expect(markStrength(0, 7.5)).toBe(0);
    const between = markStrength(0, 8.25);
    expect(between).toBeGreaterThan(0);
    expect(between).toBeLessThan(1);
    expect(markStrength(0, 9)).toBe(1);
    expect(markStrength(0, 17)).toBe(1);
  });
});

/**
 * The marks' lattice and chevrons as the shaders find them (markLattice in
 * the vertex shader, chevron and marked in the fragment shader), in
 * JavaScript: the shaders cannot run here, and the test above holds them
 * to the lines this mirrors.
 */
describe("the marks of the way flown, as the shaders draw them", () => {
  const smooth = (a: number, b: number, x: number): number => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const SIZE = 12;
  const STROKE = 1.5;
  const SPACING = 64;
  /** The stroke of a chevron `ahead` of its line and `across` the track */
  const chevron = (ahead: number, across: number): number =>
    (1 -
      smooth(
        STROKE - 0.5,
        STROKE + 0.5,
        Math.abs(ahead - 0.4 * SIZE + 0.8 * Math.abs(across)) * 0.78086881,
      )) *
    (1 - smooth(SIZE - 0.5, SIZE + 0.5, Math.abs(across)));
  /**
   * The lattice of a stretch from `[x0, y0]` to `[x1, y1]` on the ground
   * that spans `lengthPx` on the screen: where its start is among the
   * lines, from an even one, the pixels from a line to the next, and how
   * far they have gone to every second one
   */
  const latticeOf = (
    [x0, y0, x1, y1]: readonly number[],
    lengthPx: number,
  ): [number, number, number] => {
    const units = Math.hypot(x1! - x0!, y1! - y0!);
    const perUnit = lengthPx / units;
    const [dx, dy] = [(x1! - x0!) / units, (y1! - y0!) / units];
    const octave = Math.log2(SPACING / perUnit);
    const apart = 2 ** Math.floor(octave);
    const eighth = Math.PI / 8;
    const axis = Math.floor(Math.atan2(dy, dx) / eighth + 0.5) * eighth;
    const [nx, ny] = [Math.cos(axis), Math.sin(axis)];
    const line = (x0! * nx + y0! * ny) / apart;
    return [
      line - 2 * Math.floor(0.5 * line),
      (perUnit * apart) / (dx * nx + dy * ny),
      octave - Math.floor(octave),
    ];
  };
  /** The stroke on the middle of the track `px` along it from its start */
  const markAt = (
    [start, spacing, coarser]: readonly number[],
    px: number,
  ): number => {
    const line = start! + px / spacing!;
    const half = 0.5 * line;
    return (
      chevron((line - Math.floor(line + 0.5)) * spacing!, 0) * (1 - coarser!) +
      chevron((half - Math.floor(half + 0.5)) * 2 * spacing!, 0) * coarser!
    );
  };
  /** The middles of the strokes along `lengthPx` of a stretch, and theirs */
  const strokes = (
    lattice: readonly number[],
    lengthPx: number,
  ): [px: number, stroke: number][] => {
    const found: [number, number][] = [];
    let before = 0;
    let top = -1;
    for (let px = 0; px <= lengthPx; px += 0.25) {
      const here = markAt(lattice, px);
      if (here > before + 1e-9) top = px;
      else if (top >= 0 && here < before - 1e-9) {
        found.push([(top + px - 0.25) / 2, before]);
        top = -1;
      }
      before = here;
    }
    // Not those cut by either end
    return found.filter(([px]) => px > SIZE && px < lengthPx - SIZE);
  };
  /** A straight track `lengthPx` long on the screen at `perUnit` */
  const track = (
    degrees: number,
    lengthPx: number,
    perUnit: number,
    from: readonly [number, number] = [37.3, 91.7],
  ): number[] => {
    const heading = (degrees * Math.PI) / 180;
    const units = lengthPx / perUnit;
    return [
      from[0],
      from[1],
      from[0] + Math.cos(heading) * units,
      from[1] + Math.sin(heading) * units,
    ];
  };

  it("draws one row of chevrons along a track, a line of its lattice apart, at every heading", () => {
    // Those halfway between two axes too, where a blend of the lattices of
    // both drew two rows of marks at half their strength
    for (let degrees = 0; degrees < 360; degrees += 3.75) {
      for (const perUnit of [1, 1.3, 1.7]) {
        const lattice = latticeOf(track(degrees, 600, perUnit), 600);
        const [start, spacing, coarser] = lattice;
        expect(spacing).toBeGreaterThanOrEqual(SPACING / 2 - 1e-9);
        expect(spacing).toBeLessThanOrEqual(
          SPACING / Math.cos(Math.PI / 16) + 1e-9,
        );
        const found = strokes(lattice, 600);
        expect(found.length).toBeGreaterThanOrEqual(
          Math.floor(600 / spacing) - 2,
        );
        for (const [px, stroke] of found) {
          // On a line, its tip 0.4 of the size ahead of it
          const line = start + (px - 0.4 * SIZE) / spacing;
          expect(Math.abs(line - Math.round(line)) * spacing).toBeLessThan(1);
          // Every second one in full, those between fading with the octave
          const even = Math.round(line) % 2 === 0;
          expect(stroke).toBeCloseTo(even ? 1 : 1 - coarser, 1);
        }
      }
    }
  });

  it("points a chevron ahead, its arms trailing back from its tip", () => {
    // The middle of the stroke, at `across` from the middle of the track
    const peak = (across: number): number => {
      const on: number[] = [];
      for (let ahead = -SIZE; ahead <= SIZE; ahead += 0.05) {
        if (chevron(ahead, across) > 0.999) on.push(ahead);
      }
      return (on[0]! + on[on.length - 1]!) / 2;
    };
    expect(peak(0)).toBeCloseTo(0.4 * SIZE, 0);
    expect(peak(0.5 * SIZE)).toBeCloseTo(0, 0);
    expect(peak(-0.8 * SIZE)).toBeCloseTo(-0.24 * SIZE, 0);
    expect(chevron(0, 1.5 * SIZE)).toBe(0);
  });

  /** Where the pixel `px` along a stretch of `lattice` is among its lines */
  const lineOf = ([start, spacing]: readonly number[], px: number): number =>
    start! + px / spacing!;
  /** Whether two places among the lines are the same, every second even */
  const sameLine = (one: number, other: number): void => {
    const apart = (one - other) / 2;
    expect(Math.abs(apart - Math.round(apart))).toBeLessThan(1e-6);
  };

  it("marks the same places for every flight along a track, whichever way and wherever its stretches end", () => {
    const whole = track(33, 800, 1.2);
    const there = latticeOf(whole, 800);
    // Another flight's stretch, from a third of the way in, is on the same
    // lines at the same places
    const later = latticeOf(
      [
        whole[0]! + (whole[2]! - whole[0]!) / 3,
        whole[1]! + (whole[3]! - whole[1]!) / 3,
        whole[2]!,
        whole[3]!,
      ],
      (800 * 2) / 3,
    );
    expect(later[1]).toBeCloseTo(there[1], 9);
    for (const px of [0, 100, 437]) {
      sameLine(lineOf(later, px), lineOf(there, 800 / 3 + px));
    }
    // The way back crosses the same lines, counted from the other side
    const back = latticeOf([whole[2]!, whole[3]!, whole[0]!, whole[1]!], 800);
    expect(back[1]).toBeCloseTo(there[1], 9);
    for (const px of [0, 100, 437]) {
      sameLine(-lineOf(back, 800 - px), lineOf(there, px));
    }
  });

  it("marks the part of a stretch in front of the near plane where the whole stretch has them", () => {
    const whole = track(71, 900, 1.5);
    // The first 40 % of it behind the camera: the part left starts there,
    // on the ground as on the screen
    const kept = 0.4;
    const cut = [
      whole[0]! + (whole[2]! - whole[0]!) * kept,
      whole[1]! + (whole[3]! - whole[1]!) * kept,
      whole[2]!,
      whole[3]!,
    ];
    const there = latticeOf(whole, 900);
    const left = latticeOf(cut, 900 * (1 - kept));
    // Its ground left at the whole stretch's, the lines were elsewhere
    const stale = latticeOf(whole, 900 * (1 - kept));
    let off = 0;
    for (const px of [0, 50, 200, 499]) {
      sameLine(lineOf(left, px), lineOf(there, 900 * kept + px));
      const miss = lineOf(stale, px) - lineOf(there, 900 * kept + px);
      off = Math.max(off, Math.abs(miss - Math.round(miss)));
    }
    expect(off).toBeGreaterThan(0.1);
  });
});

describe("cloudExposure", () => {
  /** The heat per metre of `count` cruises over the same track */
  const cruises = (count: number): number => count / 51.4;

  it("draws the busiest cells no hotter than white, the whole cloud darker for them", () => {
    const hundred = cloudExposure(cruises(100));
    expect(hundred).toBeLessThan(1);
    expect(cloudExposure(cruises(200))).toBeCloseTo(hundred / 2, 9);
    // Years of flights over one field are not darkened to nothing
    expect(cloudExposure(cruises(10000))).toBe(cloudExposure(cruises(20000)));
    expect(cloudExposure(cruises(10000))).toBeGreaterThan(0);
  });

  it("never draws the cloud brighter than its colours are made for", () => {
    expect(cloudExposure(cruises(10))).toBe(1);
    expect(cloudExposure(cruises(0.1))).toBe(1);
    expect(cloudExposure(0)).toBe(1);
    expect(cloudExposure(Number.NaN)).toBe(1);
  });
});

describe("cloudMatrix", () => {
  /** A column-major matrix times a vector */
  function times(m: ArrayLike<number>, v: number[]): number[] {
    return [0, 1, 2, 3].map(
      (row) =>
        m[row]! * v[0]! +
        m[4 + row]! * v[1]! +
        m[8 + row]! * v[2]! +
        m[12 + row]! * v[3]!,
    );
  }

  it("takes a point from the origin, with a height in metres, where MapLibre's matrix takes it in Mercator units", () => {
    const mercator = [
      2, 0.5, 0.1, 0.01, -0.3, 1.5, 0.2, 0.02, 0.4, -0.6, 3, 0.03, 7, -3, 1, 1,
    ];
    const origin: [number, number] = [0.53, 0.35];
    const lat = 47;
    const matrix = cloudMatrix(mercator, origin, lat);
    const metresPerUnit =
      2 * Math.PI * 6371008.8 * Math.cos((lat * Math.PI) / 180);

    const offset = [0.001, -0.002];
    const heightM = 1500;
    const ours = times(matrix, [offset[0]!, offset[1]!, heightM, 1]);
    const theirs = times(mercator, [
      origin[0] + offset[0]!,
      origin[1] + offset[1]!,
      heightM / metresPerUnit,
      1,
    ]);
    ours.forEach((value, i) => expect(value).toBeCloseTo(theirs[i]!, 5));
  });
});

describe("cloudLook", () => {
  it("keeps the glow of a region out to the first stop, and narrows and dims it closer in", () => {
    const [first] = CLOUD_STOPS;
    expect(cloudLook(4)).toEqual({ sigmaPx: first![1], gain: first![2] });
    expect(cloudLook(first![0])).toEqual({
      sigmaPx: first![1],
      gain: first![2],
    });
    let before = cloudLook(first![0]);
    for (let zoom = first![0] + 0.25; zoom <= 16; zoom += 0.25) {
      const look = cloudLook(zoom);
      expect(look.sigmaPx).toBeLessThanOrEqual(before.sigmaPx);
      expect(look.gain).toBeLessThanOrEqual(before.gain);
      before = look;
    }
    const last = CLOUD_STOPS[CLOUD_STOPS.length - 1]!;
    expect(cloudLook(18)).toEqual({ sigmaPx: last[1], gain: last[2] });
  });

  it("runs straight from one stop to the next", () => {
    const [[z0, s0, g0], [z1, s1, g1]] = CLOUD_STOPS as [
      readonly [number, number, number],
      readonly [number, number, number],
    ];
    const middle = cloudLook((z0 + z1) / 2);
    expect(middle.sigmaPx).toBeCloseTo((s0 + s1) / 2, 9);
    expect(middle.gain).toBeCloseTo((g0 + g1) / 2, 9);
  });
});
