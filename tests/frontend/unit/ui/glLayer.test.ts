/**
 * What the two custom WebGL layers share (ui/glLayer.ts), with the context
 * mocked: the buffers and the vertex array made once per context, the
 * points uploaded when they are new, a program per projection built on
 * MapLibre's prelude, what a shader that does not compile or a program
 * that does not link leaves behind, a lost context, letting go, and where
 * a layer goes among the map's.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import {
  cloudMatrix,
  LayerGl,
  placeBelow,
  setProjection,
  worldCopies,
  type LayerShaders,
} from "../../../../flown/frontend/ui/glLayer";
import { Map as MockMap } from "../../../mocks/maplibre-gl";

/** A WebGL2 context that records what is asked of it */
function mockGl() {
  let objects = 0;
  const made = (kind: string) => vi.fn(() => ({ kind, n: objects++ }));
  return {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    createBuffer: made("buffer") as Mock<() => object | null>,
    createVertexArray: made("vao") as Mock<() => object | null>,
    createProgram: made("program"),
    createShader: made("shader") as Mock<() => object | null>,
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => "ERROR: 0:1: nonsense"),
    attachShader: vi.fn(),
    deleteShader: vi.fn(),
    bindAttribLocation: vi.fn(
      (_program: unknown, _location: number, _name: string) => undefined,
    ),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => "a varying is not written"),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    useProgram: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    uniform4f: vi.fn(),
    uniform4fv: vi.fn(),
    deleteBuffer: vi.fn((_buffer: unknown) => undefined),
    deleteVertexArray: vi.fn((_vao: unknown) => undefined),
    deleteProgram: vi.fn((_program: unknown) => undefined),
    isContextLost: vi.fn(() => false),
    isProgram: vi.fn((_program: unknown) => true),
  };
}

type MockGl = ReturnType<typeof mockGl>;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** What MapLibre hands a custom layer for a frame, in Mercator or on the globe */
function frame(globe = false): CustomRenderMethodInput {
  const main = new Float64Array(IDENTITY);
  main[0] = 2;
  const fallback = new Float64Array(IDENTITY);
  fallback[5] = 3;
  return {
    shaderData: {
      variantName: globe ? "globe" : "mercator",
      vertexShaderPrelude: "uniform mat4 u_projection_matrix;",
      define: globe ? "#define GLOBE" : "",
    },
    defaultProjectionData: {
      mainMatrix: main,
      fallbackMatrix: fallback,
      tileMercatorCoords: [0, 0, 1, 1],
      clippingPlane: [1, 2, 3, 4],
      projectionTransition: 0.5,
    },
  } as unknown as CustomRenderMethodInput;
}

const VERTEX = "in vec2 a_corner;\nin vec4 a_point;\nvoid main() {}";
const FRAGMENT = "#version 300 es\nprecision highp float;\nvoid main() {}";

describe("LayerGl", () => {
  let gl: MockGl;
  let failed: Mock;
  let layout: Mock<(gl: WebGL2RenderingContext) => void>;
  let objects: LayerGl<"u_time" | "u_colour">;
  const data = { points: new Float32Array([1, 2, 3, 4]) };

  const context = (of: MockGl = gl): WebGL2RenderingContext =>
    of as unknown as WebGL2RenderingContext;
  const begin = (options = frame(), points = data, of = gl) =>
    objects.begin(context(of), options, points);
  /** Where the calls of `fn` came among all calls to the mocks */
  const order = (fn: Mock): number[] => fn.mock.invocationCallOrder;
  /** The arguments of the last call of `fn` before the call at `at` */
  const lastBefore = (fn: Mock, at: number): unknown[] | undefined =>
    fn.mock.calls.filter((_, k) => order(fn)[k]! < at).at(-1);

  beforeEach(() => {
    gl = mockGl();
    failed = vi.fn();
    layout = vi.fn();
    const shaders: LayerShaders<"u_time" | "u_colour"> = {
      owner: "the test layer's",
      vertex: VERTEX,
      fragment: FRAGMENT,
      attributes: ["a_corner", "a_point"],
      uniforms: ["u_time", "u_colour"],
      layout,
    };
    objects = new LayerGl(shaders, failed);
  });

  describe("the buffers", () => {
    it("are made as it first draws, a quad's corners at location 0 and the points laid out by the layer, in its vertex array", () => {
      const ready = begin();

      expect(ready).not.toBeNull();
      expect(gl.createBuffer).toHaveBeenCalledTimes(2);
      expect(gl.createVertexArray).toHaveBeenCalledOnce();
      const [corners, points] = gl.createBuffer.mock.results.map(
        (result) => result.value as object,
      );
      const vao = gl.createVertexArray.mock.results[0]!.value as object;
      expect(ready!.vao).toBe(vao);
      // The corners of a quad, as a triangle strip
      expect(gl.bufferData).toHaveBeenCalledWith(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      expect(gl.enableVertexAttribArray).toHaveBeenCalledWith(0);
      expect(gl.vertexAttribPointer).toHaveBeenCalledWith(
        0,
        2,
        gl.FLOAT,
        false,
        0,
        0,
      );
      // The layer lays the points out with their buffer and the vertex
      // array bound, and the corners' attribute set in that array
      expect(layout).toHaveBeenCalledOnce();
      expect(layout).toHaveBeenCalledWith(gl);
      const laidOut = order(layout)[0]!;
      expect(lastBefore(gl.bindBuffer, laidOut)).toEqual([
        gl.ARRAY_BUFFER,
        points,
      ]);
      expect(lastBefore(gl.bindVertexArray, laidOut)).toEqual([vao]);
      expect(order(gl.vertexAttribPointer)[0]!).toBeLessThan(laidOut);
      // The corners went into the other buffer
      expect(lastBefore(gl.bindBuffer, order(gl.bufferData)[0]!)).toEqual([
        gl.ARRAY_BUFFER,
        corners,
      ]);
    });

    it("leave nothing bound behind them for MapLibre's next draw", () => {
      begin();
      const afterMaking = order(layout)[0]!;
      const unbound = (fn: Mock): boolean =>
        fn.mock.calls.some(
          (call, k) => call.at(-1) === null && order(fn)[k]! > afterMaking,
        );
      expect(unbound(gl.bindVertexArray)).toBe(true);
      expect(unbound(gl.bindBuffer)).toBe(true);
    });

    it("are made once per context, and the points uploaded again only when they are other points", () => {
      begin();
      begin();
      begin();
      expect(gl.createBuffer).toHaveBeenCalledTimes(2);
      expect(gl.createVertexArray).toHaveBeenCalledOnce();
      const uploads = (of: object): number =>
        gl.bufferData.mock.calls.filter(([, points]) => points === of).length;
      expect(uploads(data.points)).toBe(1);
      // Into the points' buffer, not the corners'
      const points = gl.createBuffer.mock.results[1]!.value as object;
      const upload = gl.bufferData.mock.calls.findIndex(
        ([, uploaded]) => uploaded === data.points,
      );
      expect(lastBefore(gl.bindBuffer, order(gl.bufferData)[upload]!)).toEqual([
        gl.ARRAY_BUFFER,
        points,
      ]);

      // The same numbers in another object are other points
      const next = { points: new Float32Array(data.points) };
      begin(frame(), next);
      begin(frame(), next);
      expect(uploads(next.points)).toBe(1);
      begin();
      expect(uploads(data.points)).toBe(2);
    });

    it("that cannot be made are reported, and nothing is drawn", () => {
      gl.createVertexArray.mockReturnValue(null);
      expect(begin()).toBeNull();

      expect(failed).toHaveBeenCalledOnce();
      expect(String(failed.mock.calls[0]![0])).toContain(
        "the test layer's buffers could not be made",
      );
      expect(gl.createProgram).not.toHaveBeenCalled();
      expect(gl.useProgram).not.toHaveBeenCalled();
    });
  });

  describe("the program", () => {
    /** The sources handed to the vertex shaders, in order */
    const vertexSources = (): string[] =>
      gl.shaderSource.mock.calls
        .map(([, source]) => source as string)
        .filter((source) => source.includes("a_corner"));

    it("is built on MapLibre's prelude for the frame's projection, and put in use", () => {
      const ready = begin();

      expect(vertexSources()).toEqual([
        `#version 300 es\nuniform mat4 u_projection_matrix;\n\n${VERTEX}`,
      ]);
      // The fragment shader is shipped as it is written
      expect(gl.shaderSource).toHaveBeenCalledWith(expect.anything(), FRAGMENT);
      const program = gl.createProgram.mock.results[0]!.value as object;
      expect(ready!.program.program).toBe(program);
      expect(gl.useProgram).toHaveBeenLastCalledWith(program);
      // Both shaders go with the program, which keeps them
      expect(gl.attachShader).toHaveBeenCalledTimes(2);
      expect(gl.deleteShader).toHaveBeenCalledTimes(2);
      expect(gl.deleteProgram).not.toHaveBeenCalled();
    });

    it("binds the attributes where the layout expects them, in their order, before it links", () => {
      begin();
      expect(
        gl.bindAttribLocation.mock.calls.map(([, at, name]) => [at, name]),
      ).toEqual([
        [0, "a_corner"],
        [1, "a_point"],
      ]);
      expect(Math.max(...order(gl.bindAttribLocation))).toBeLessThan(
        order(gl.linkProgram)[0]!,
      );
    });

    it("knows where the projection's uniforms and the layer's own are", () => {
      const ready = begin();
      expect(Object.keys(ready!.program.uniforms).sort()).toEqual(
        [
          "u_colour",
          "u_projection_clipping_plane",
          "u_projection_fallback_matrix",
          "u_projection_matrix",
          "u_projection_tile_mercator_coords",
          "u_projection_transition",
          "u_time",
        ].sort(),
      );
      expect(ready!.program.uniforms.u_time).toEqual({ name: "u_time" });
    });

    it("is compiled once per projection, the globe's with its define, and kept for the frames after", () => {
      const mercator = begin()!.program;
      const globe = begin(frame(true))!.program;
      expect(begin()!.program).toBe(mercator);
      expect(begin(frame(true))!.program).toBe(globe);

      expect(globe).not.toBe(mercator);
      expect(gl.createProgram).toHaveBeenCalledTimes(2);
      expect(vertexSources()[1]).toBe(
        `#version 300 es\nuniform mat4 u_projection_matrix;\n#define GLOBE\n${VERTEX}`,
      );
      // One set of buffers for both
      expect(gl.createVertexArray).toHaveBeenCalledOnce();
    });

    it("whose shader does not compile is reported with its log, once for the projection, and nothing is left of it", () => {
      gl.getShaderParameter.mockReturnValue(false);
      expect(begin()).toBeNull();
      expect(begin()).toBeNull();

      expect(failed).toHaveBeenCalledOnce();
      const error = String(failed.mock.calls[0]![0]);
      expect(error).toContain("the test layer's shader did not compile");
      expect(error).toContain("ERROR: 0:1: nonsense");
      expect(gl.createShader).toHaveBeenCalledOnce();
      expect(gl.deleteShader).toHaveBeenCalledOnce();
      expect(gl.deleteProgram).toHaveBeenCalledOnce();
      expect(gl.linkProgram).not.toHaveBeenCalled();
      expect(gl.useProgram).not.toHaveBeenCalled();
      // The points are not uploaded for a frame that draws nothing
      expect(
        gl.bufferData.mock.calls.filter(([, points]) => points === data.points),
      ).toHaveLength(0);
    });

    it("that does not link is reported with its log and deleted", () => {
      gl.getProgramParameter.mockReturnValue(false);
      expect(begin()).toBeNull();

      expect(failed).toHaveBeenCalledOnce();
      const error = String(failed.mock.calls[0]![0]);
      expect(error).toContain("the test layer's program did not link");
      expect(error).toContain("a varying is not written");
      expect(gl.deleteProgram).toHaveBeenCalledWith(
        gl.createProgram.mock.results[0]!.value,
      );
      expect(gl.getUniformLocation).not.toHaveBeenCalled();
    });

    it("that cannot be made for one projection is still tried for the other", () => {
      gl.getShaderParameter.mockReturnValueOnce(false);
      expect(begin()).toBeNull();
      expect(begin(frame(true))).not.toBeNull();
      expect(begin()).toBeNull();
      expect(failed).toHaveBeenCalledOnce();
    });

    it("says so where the context gives no shader", () => {
      gl.createShader.mockReturnValue(null);
      expect(begin()).toBeNull();
      expect(String(failed.mock.calls[0]![0])).toContain(
        "the test layer's shaders could not be made",
      );
    });
  });

  describe("a lost context", () => {
    it("takes everything with it: the context restored, the same object, gets everything anew", () => {
      begin();
      // MapLibre takes the layer off the map before it says the context is
      // lost, and the app adds it again once the context is back
      gl.isContextLost.mockReturnValue(true);
      objects.release(context());
      gl.isContextLost.mockReturnValue(false);
      const ready = begin();

      expect(ready).not.toBeNull();
      expect(gl.createBuffer).toHaveBeenCalledTimes(4);
      expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
      expect(gl.createProgram).toHaveBeenCalledTimes(2);
      expect(
        gl.bufferData.mock.calls.filter(([, points]) => points === data.points),
      ).toHaveLength(2);
      // Nothing of the lost context is deleted in the new one
      expect(gl.deleteBuffer).not.toHaveBeenCalled();
      expect(gl.deleteProgram).not.toHaveBeenCalled();
    });

    it("and another context get everything anew as well", () => {
      begin();
      const other = mockGl();
      expect(begin(frame(), data, other)).not.toBeNull();
      expect(other.createBuffer).toHaveBeenCalledTimes(2);
      expect(other.createProgram).toHaveBeenCalledOnce();
      expect(other.bufferData).toHaveBeenCalledWith(
        other.ARRAY_BUFFER,
        data.points,
        other.STATIC_DRAW,
      );
    });
  });

  describe("empty", () => {
    it("lets go of the points it uploaded, and uploads them again once asked to draw them", () => {
      begin();
      const points = gl.createBuffer.mock.results[1]!.value as unknown;
      gl.bufferData.mockClear();

      objects.empty(context());

      expect(gl.bufferData).toHaveBeenCalledWith(
        gl.ARRAY_BUFFER,
        0,
        gl.STATIC_DRAW,
      );
      expect(lastBefore(gl.bindBuffer, order(gl.bufferData)[0]!)).toEqual([
        gl.ARRAY_BUFFER,
        points,
      ]);
      // Nothing is deleted: the buffer takes the next points
      expect(gl.deleteBuffer).not.toHaveBeenCalled();

      gl.bufferData.mockClear();
      begin();
      expect(gl.bufferData).toHaveBeenCalledWith(
        gl.ARRAY_BUFFER,
        data.points,
        gl.STATIC_DRAW,
      );
    });

    it("does nothing without points, nor in another context", () => {
      objects.empty(context());
      begin();
      objects.empty(context(mockGl()));
      objects.empty(context());
      gl.bufferData.mockClear();

      objects.empty(context());

      expect(gl.bufferData).not.toHaveBeenCalled();
    });
  });

  describe("release", () => {
    it("deletes the buffers and the vertex array, and keeps the programs for the layer's return", () => {
      begin();
      begin(frame(true));
      objects.release(context());

      const buffers = gl.createBuffer.mock.results.map(
        (r) => r.value as unknown,
      );
      expect(gl.deleteBuffer.mock.calls.map(([buffer]) => buffer)).toEqual(
        buffers,
      );
      expect(gl.deleteVertexArray).toHaveBeenCalledWith(
        gl.createVertexArray.mock.results[0]!.value,
      );
      expect(gl.deleteProgram).not.toHaveBeenCalled();

      // Once: a second release has nothing left, and a frame after it makes
      // the buffers anew but takes the programs it kept
      objects.release(context());
      expect(gl.deleteBuffer).toHaveBeenCalledTimes(2);
      begin();
      begin(frame(true));
      expect(gl.createVertexArray).toHaveBeenCalledTimes(2);
      expect(gl.createProgram).toHaveBeenCalledTimes(2);
    });

    it("makes the programs anew where the context lost them while off the map", () => {
      begin();
      objects.release(context());
      // The same context object, restored without them
      gl.isProgram.mockReturnValue(false);
      begin();
      expect(gl.createProgram).toHaveBeenCalledTimes(2);
    });

    it("keeps no program that did not compile: back on the map, it is tried again and told again", () => {
      // The globe's works, the flat map's does not
      begin(frame(true));
      gl.getShaderParameter.mockReturnValueOnce(false);
      expect(begin()).toBeNull();
      expect(failed).toHaveBeenCalledOnce();
      objects.release(context());

      // Back in the same context object, as after a loss the layer did not
      // hear of while off the map: the globe's program is kept, the
      // failure is not
      expect(begin(frame(true))).not.toBeNull();
      expect(gl.createProgram).toHaveBeenCalledTimes(2);
      gl.getShaderParameter.mockReturnValueOnce(false);
      expect(begin()).toBeNull();
      expect(gl.createProgram).toHaveBeenCalledTimes(3);
      expect(failed).toHaveBeenCalledTimes(2);

      // And where it compiles now, it draws
      objects.release(context());
      expect(begin()).not.toBeNull();
      expect(failed).toHaveBeenCalledTimes(2);
    });

    it("makes the programs anew in another context", () => {
      begin();
      objects.release(context());
      const other = mockGl();
      begin(frame(), data, other);
      expect(other.createProgram).toHaveBeenCalledOnce();
      expect(other.isProgram).not.toHaveBeenCalled();
    });

    it("touches neither a lost context nor another than the one it made them in", () => {
      begin();
      gl.isContextLost.mockReturnValue(true);
      objects.release(context());
      expect(gl.deleteBuffer).not.toHaveBeenCalled();

      gl.isContextLost.mockReturnValue(false);
      begin();
      const other = mockGl();
      objects.release(context(other));
      expect(other.deleteBuffer).not.toHaveBeenCalled();
      expect(gl.deleteBuffer).not.toHaveBeenCalled();
    });

    it("does nothing before anything was made", () => {
      objects.release(context());
      expect(gl.deleteBuffer).not.toHaveBeenCalled();
      expect(gl.isContextLost).not.toHaveBeenCalled();
    });
  });
});

describe("setProjection", () => {
  let gl: MockGl;
  const origin = [0.53, 0.34] as const;
  const lat = 51.5;
  const u = {
    u_projection_matrix: { name: "matrix" },
    u_projection_tile_mercator_coords: { name: "tile" },
    u_projection_clipping_plane: { name: "clipping" },
    u_projection_transition: { name: "transition" },
    u_projection_fallback_matrix: { name: "fallback" },
  };
  const set = (options: CustomRenderMethodInput): void =>
    setProjection(
      gl as unknown as WebGL2RenderingContext,
      u,
      options,
      origin,
      lat,
    );
  /** The matrix given to a uniform */
  const matrix = (name: string): number[] | undefined => {
    const call = gl.uniformMatrix4fv.mock.calls.find(
      ([location]) => (location as { name: string }).name === name,
    );
    return call ? [...(call[2] as Float32Array)] : undefined;
  };

  beforeEach(() => {
    gl = mockGl();
  });

  it("gives the flat map its matrix moved to the origin, and nothing of the globe's", () => {
    const options = frame();
    set(options);

    expect(matrix("matrix")).toEqual([
      ...cloudMatrix(options.defaultProjectionData.mainMatrix, origin, lat),
    ]);
    expect(matrix("fallback")).toBeUndefined();
    expect(gl.uniform4f).not.toHaveBeenCalled();
    expect(gl.uniform4fv).not.toHaveBeenCalled();
    expect(gl.uniform1f).not.toHaveBeenCalled();
  });

  it("gives the globe its own matrix, the flat map's for the way into it, the origin as the tile, the clipping plane and the transition", () => {
    const options = frame(true);
    set(options);

    expect(matrix("matrix")).toEqual([
      ...new Float32Array(options.defaultProjectionData.mainMatrix),
    ]);
    expect(matrix("fallback")).toEqual([
      ...cloudMatrix(options.defaultProjectionData.fallbackMatrix, origin, lat),
    ]);
    expect(gl.uniform4f).toHaveBeenCalledWith(
      u.u_projection_tile_mercator_coords,
      origin[0],
      origin[1],
      1,
      1,
    );
    expect(gl.uniform4fv).toHaveBeenCalledWith(
      u.u_projection_clipping_plane,
      [1, 2, 3, 4],
    );
    expect(gl.uniform1f).toHaveBeenCalledWith(u.u_projection_transition, 0.5);
  });
});

describe("worldCopies", () => {
  /** A map whose view spans `west` to `east`, unwrapped */
  const view = (west: number, east: number, copies = true): MapLibreMap =>
    ({
      getBounds: () => ({ getWest: () => west, getEast: () => east }),
      getRenderWorldCopies: () => copies,
    }) as unknown as MapLibreMap;
  /** Points from `from` to `to` degrees of longitude, in Mercator x */
  const xs = (from: number, to: number): [number, number] => [
    (from + 180) / 360,
    (to + 180) / 360,
  ];

  it("is world 0 alone for points in a view of it", () => {
    expect(worldCopies(view(5, 15), frame(), xs(10, 12))).toEqual([0]);
  });

  it("draws points beside the antimeridian on the side the view is", () => {
    // Flights at 179.5 W, seen from 179.9 E: the copy a world east
    expect(worldCopies(view(179, 181), frame(), xs(-179.6, -179.4))).toEqual([
      1,
    ]);
    // A flight from 179.5 E on past 180, seen from 179.9 W: a world west
    expect(worldCopies(view(-181, -179), frame(), xs(179.5, 180.5))).toEqual([
      -1,
    ]);
  });

  it("draws every copy a view of more than a world shows, and none off it", () => {
    expect(worldCopies(view(-400, 400), frame(), xs(10, 12))).toEqual([
      -1, 0, 1,
    ]);
    expect(worldCopies(view(100, 110), frame(), xs(10, 12))).toEqual([]);
  });

  it("draws no more copies than MapLibre: three either side of world 0", () => {
    // A tilt of 85 at the least zoom on a wide screen spans dozens
    expect(worldCopies(view(-6000, 6000), frame(), xs(10, 12))).toEqual([
      -3, -2, -1, 0, 1, 2, 3,
    ]);
    expect(worldCopies(view(2000, 2200), frame(), xs(10, 12))).toEqual([]);
  });

  it("draws world 0 alone where the map renders no world copies", () => {
    expect(worldCopies(view(-400, 400, false), frame(), xs(10, 12))).toEqual([
      0,
    ]);
    expect(
      worldCopies(view(179, 181, false), frame(), xs(-179.6, -179.4)),
    ).toEqual([]);
  });

  it("is world 0 on the globe, which is one world", () => {
    expect(worldCopies(view(100, 110), frame(true), xs(10, 12))).toEqual([0]);
  });
});

describe("placeBelow", () => {
  /** A map whose layers are in the order of `ids` */
  function mapOf(...ids: string[]): MockMap {
    const map = new MockMap({ container: "map", style: { layers: [] } });
    map.finishStyleLoad();
    for (const id of ids) map.addLayer({ id, type: "background" });
    return map;
  }
  const asMap = (map: MockMap): MapLibreMap => map as unknown as MapLibreMap;
  const layer = { id: "mine", type: "custom" } as CustomLayerInterface;

  it("adds the layer below the first of the layers named the map has", () => {
    const map = mapOf("a", "labels", "top");

    placeBelow(asMap(map), layer, false, ["missing", "labels", "top"]);

    expect(map.getLayersOrder()).toEqual(["a", "mine", "labels", "top"]);
  });

  it("adds it on top without any of them", () => {
    const map = mapOf("a");

    placeBelow(asMap(map), layer, false, ["missing"]);

    expect(map.getLayersOrder()).toEqual(["a", "mine"]);
  });

  it("moves it back below them after a new style, and leaves it in place", () => {
    const map = mapOf("mine", "a", "labels");

    placeBelow(asMap(map), layer, true, ["labels"]);
    expect(map.getLayersOrder()).toEqual(["a", "mine", "labels"]);

    map.moveLayer.mockClear();
    placeBelow(asMap(map), layer, true, ["labels"]);
    expect(map.moveLayer).not.toHaveBeenCalled();
  });
});
