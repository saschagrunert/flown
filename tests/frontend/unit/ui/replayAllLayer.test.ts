/**
 * The custom layer of the replay of all flights, with the WebGL context
 * mocked: it uploads the flights once, and a frame only sets the time.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type { CustomRenderMethodInput, Map as MapLibreMap } from "maplibre-gl";
import {
  REPLAY_ALL_LAYER,
  ReplayAllLayer,
  type ReplayAllStyle,
} from "../../../../flown/frontend/ui/replayAllLayer";
import {
  replayAllPoints,
  type ReplayAllPoints,
} from "../../../../flown/frontend/calculations/replayAll";
import { flightClock } from "../../../../flown/frontend/calculations/flightClock";
import { smoothFlights } from "../../../../flown/frontend/calculations/smoothing";
import { RELIEF_MAX_LEVEL } from "../../../../flown/frontend/calculations/lift";
import type { PathSegment } from "../../../../flown/frontend/types";

/** A WebGL2 context that records what is asked of it */
function mockGl(compiles = true) {
  let objects = 0;
  const made = (kind: string) => vi.fn(() => ({ kind, n: objects++ }));
  return {
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
    ONE_MINUS_SRC_ALPHA: 11,
    DEPTH_TEST: 12,
    CULL_FACE: 13,
    STENCIL_TEST: 14,
    TRIANGLE_STRIP: 15,
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
    depthMask: vi.fn(),
    drawArraysInstanced: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    deleteProgram: vi.fn(),
    isProgram: vi.fn(() => true),
    isContextLost: vi.fn(() => false),
  };
}

type MockGl = ReturnType<typeof mockGl>;

function frame(globe = false): CustomRenderMethodInput {
  const identity = new Float64Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ]);
  return {
    farZ: 1000,
    nearZ: 1,
    fov: 0.6435,
    modelViewProjectionMatrix: identity,
    projectionMatrix: new Float64Array(identity),
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

function mockMap(): MapLibreMap {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getCenter: vi.fn(() => ({ lng: 11, lat: 47 })),
    // A view a degree either side of the centre, the flat map's (see
    // worldCopies)
    getRenderWorldCopies: vi.fn(() => true),
    getBounds: vi.fn(function (this: MapLibreMap) {
      const { lng } = this.getCenter();
      return { getWest: () => lng - 1, getEast: () => lng + 1 };
    }),
    getPixelRatio: vi.fn(() => 2),
    triggerRepaint: vi.fn(),
  } as unknown as MapLibreMap;
}

/** Two flights of five fixes each */
function flights(): ReplayAllPoints {
  const segments: PathSegment[] = [1, 2].flatMap((path_id) =>
    [0, 1, 2, 3].map((i) => ({
      path_id,
      coords: [
        [46 + path_id, 11 + i * 0.01],
        [46 + path_id, 11 + (i + 1) * 0.01],
      ] as PathSegment["coords"],
      altitude_ft: 3000,
      groundspeed_knots: 100,
      time: i * 30,
    })),
  );
  const curves = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 0,
  });
  return replayAllPoints(
    segments,
    curves,
    flightClock(segments),
    () => true,
    14,
    RELIEF_MAX_LEVEL,
  );
}

const STYLE: ReplayAllStyle = {
  groundM: 3,
  liftM: 3,
  time: 42,
  fade: 400,
  scale: 1,
};

describe("the replay of all flights' layer", () => {
  let gl: MockGl;
  let map: MapLibreMap;
  let style: ReplayAllStyle | null;
  let failed: Mock<(error: unknown) => void>;
  let layer: ReplayAllLayer;

  const draw = (input = frame()): void =>
    layer.render(gl as unknown as WebGL2RenderingContext, input);

  beforeEach(() => {
    gl = mockGl();
    map = mockMap();
    style = STYLE;
    failed = vi.fn();
    layer = new ReplayAllLayer(() => style, failed);
    layer.onAdd(map);
  });

  it("is a 3D custom layer of its own id", () => {
    expect(layer.id).toBe(REPLAY_ALL_LAYER);
    expect(layer.type).toBe("custom");
    expect(layer.renderingMode).toBe("3d");
  });

  it("draws nothing without flights or where it is told not to", () => {
    draw();
    layer.setPoints(flights());
    style = null;
    draw();

    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
    expect(layer.frames).toBe(0);
  });

  it("draws the trails of every world copy before any of their heads", () => {
    layer.setPoints(flights());
    // A view from 10 W to 12 E a world further east: world 0 and the copy
    // east of it
    vi.mocked(map.getBounds).mockReturnValueOnce({
      getWest: () => -10,
      getEast: () => 372,
    } as unknown as ReturnType<MapLibreMap["getBounds"]>);

    draw();

    expect(gl.drawArraysInstanced).toHaveBeenCalledTimes(4);
    // The head flag of u_clock last set before each draw
    const clocks = gl.uniform3f.mock.calls
      .map((call, k) => ({
        name: (call[0] as { name: string }).name,
        at: gl.uniform3f.mock.invocationCallOrder[k]!,
        head: call[3] as number,
      }))
      .filter(({ name }) => name === "u_clock");
    const heads = gl.drawArraysInstanced.mock.invocationCallOrder.map(
      (draw) => clocks.filter(({ at }) => at < draw).at(-1)?.head,
    );
    expect(heads).toEqual([0, 0, 1, 1]);
  });

  it("draws the trails and then the heads from the same stretches", () => {
    const points = flights();
    layer.setPoints(points);

    draw();

    expect(gl.drawArraysInstanced.mock.calls).toEqual([
      [gl.TRIANGLE_STRIP, 0, 4, points.count - 1],
      [gl.TRIANGLE_STRIP, 0, 4, points.count - 1],
    ]);
    const clocks = gl.uniform3f.mock.calls.filter(
      ([location]) => (location as { name: string }).name === "u_clock",
    );
    expect(clocks.map((call): unknown[] => call.slice(1))).toEqual([
      [42, 400, 0],
      [42, 400, 1],
    ]);
    // Over the map, premultiplied, against the depth without writing it
    expect(gl.blendFuncSeparate).toHaveBeenCalledWith(
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    expect(gl.depthMask).toHaveBeenCalledExactlyOnceWith(false);
    expect(layer.frames).toBe(1);
    expect(layer.time).toBe(42);
  });

  it("draws the heads and trails at the size it is told", () => {
    layer.setPoints(flights());
    const sizes = (): unknown[][] =>
      gl.uniform2f.mock.calls
        .filter(
          ([location]) => (location as { name: string }).name === "u_size",
        )
        .map((call): unknown[] => call.slice(1));

    draw();
    style = { ...STYLE, scale: 2 };
    draw();

    const [plain, doubled] = sizes() as [number[], number[]];
    expect(doubled[0]).toBeCloseTo(2 * plain[0]!);
    expect(doubled[1]).toBeCloseTo(2 * plain[1]!);
  });

  it("uploads the flights once, and a frame after that only the time", () => {
    layer.setPoints(flights());

    draw();
    style = { ...STYLE, time: 100 };
    draw();

    expect(gl.bufferData).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(layer.time).toBe(100);
  });

  it("reads each stretch as its two points, seven floats apart, the colour with the time", () => {
    layer.setPoints(flights());

    draw();

    const stride = 7 * 4;
    const pointers = gl.vertexAttribPointer.mock.calls.slice(1);
    expect(pointers).toEqual([
      [1, 4, gl.FLOAT, false, stride, 0],
      [2, 3, gl.FLOAT, false, stride, 16],
      [3, 4, gl.FLOAT, false, stride, stride],
      [4, 3, gl.FLOAT, false, stride, stride + 16],
    ]);
  });

  it("draws a trail in the colour of the stretch, or its own, with a glow round the line, and none where the colour is negated", () => {
    layer.setPoints(flights());

    draw();

    const sources = gl.shaderSource.mock.calls.map((call) => String(call[1]));
    const vertex = sources.find((source) => source.includes("v_colour ="))!;
    // The colour of the stretch is the one of its end, three bytes in one
    // number, and the trail's own amber without one; negated, the trail
    // leaves the stretch out and its head is drawn in it
    expect(vertex).toContain("float c = abs(a_endClock.z);");
    expect(vertex).toContain("(head ? t1 <= now : a_endClock.z < 0.0)");
    expect(vertex).toContain(
      "vec3(floor(c / 65536.0), mod(floor(c / 256.0), 256.0), mod(c, 256.0)) / 255.0",
    );
    expect(vertex).toContain(": TRAIL;");
    // Three times the line for the glow, whose edge is all but clear, but
    // pulled to the camera by the line's reach alone
    expect(vertex).toContain("a_corner.y * (3.0 * u_size.x + 1.0)");
    expect(vertex).toContain("reach = u_size.x + 1.0;");
    expect(vertex).toContain("float pulled = max(w - reach * w / u_depth.w");
    const fragment = sources.find((source) => source.includes("fragColor"))!;
    expect(fragment).toContain("vec3 colour = v_colour;");
    expect(fragment).toContain("float glow = across / (1.25 * u_size.x);");
    expect(fragment).toContain("0.5 * exp(-glow * glow)");
    // At the edge of the quad, for any width of the line
    for (const half of [1.5, 3, 100]) {
      const glow = (3 * half + 1) / (1.25 * half);
      expect(0.5 * Math.exp(-(glow ** 2))).toBeLessThan(0.004);
    }
  });

  it("compiles a program for the globe of its own", () => {
    layer.setPoints(flights());

    draw();
    draw(frame(true));

    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    const sources = gl.shaderSource.mock.calls.map((call) => String(call[1]));
    expect(sources.some((source) => source.includes("#define GLOBE"))).toBe(
      true,
    );
  });

  it("pulls an end towards the camera no further than the near plane", () => {
    layer.setPoints(flights());

    draw();

    // As the heat cloud does: an end just beyond it was clipped
    const sources = gl.shaderSource.mock.calls.map((call) => String(call[1]));
    expect(
      sources.some((source) => source.includes("max(0.5 * w, near * 1.01))")),
    ).toBe(true);
  });

  it("says once that its shaders do not compile, and draws nothing", () => {
    gl = mockGl(false);
    layer.setPoints(flights());

    draw();
    draw();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(gl.drawArraysInstanced).not.toHaveBeenCalled();
  });

  it("makes its buffers anew and uploads the flights again after a lost context", () => {
    layer.setPoints(flights());
    draw();

    // MapLibre takes the layer off the map before it says the context is
    // lost; the app adds it again to the context restored, which is the
    // same object with nothing of before in it
    gl.isContextLost.mockReturnValue(true);
    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);
    gl.isContextLost.mockReturnValue(false);
    gl.isProgram.mockReturnValue(false);
    layer.onAdd(map);
    draw();

    expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
    expect(gl.createProgram).toHaveBeenCalledTimes(2);
    expect(gl.bufferData).toHaveBeenCalledTimes(4);
    expect(layer.frames).toBe(2);
  });

  it("lets go of its buffers as it is removed, and keeps its program for its return", () => {
    layer.setPoints(flights());
    draw();

    layer.onRemove(map, gl as unknown as WebGL2RenderingContext);

    expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
    expect(gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(gl.deleteProgram).not.toHaveBeenCalled();

    layer.onAdd(map);
    draw();
    expect(gl.createProgram).toHaveBeenCalledTimes(1);
    expect(layer.frames).toBe(2);
  });
});
