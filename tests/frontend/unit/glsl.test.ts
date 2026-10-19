/**
 * The shaders a minified build ships (tightenGlsl and tightenShaders in
 * scripts/build-helpers.js). The unit tests of the layers compile nothing,
 * and the build only tightens the GLSL when it minifies, so what these
 * tests hold is the one check that the shipped shaders say what the
 * written ones say.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type BuildFailure } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  assertExpectedOutputs,
  glslLiterals,
  tightenGlsl,
  tightenShaders,
} from "../../../scripts/build-helpers.js";

const UI_DIR = join(__dirname, "../../../flown/frontend/ui");
/** The layers, and the shaders a layer keeps in a module of their own */
const LAYERS = readdirSync(UI_DIR).filter((name) =>
  /(?:Layer|Shaders)\.ts$/.test(name),
);

/**
 * The tokens of GLSL, its comments and white space left out: a word or a
 * number, an operator of two characters, or any other character
 */
function tokens(glsl: string): string[] {
  const code = glsl.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  return (
    code.match(
      /[A-Za-z_]\w*|\d[\w.]*|\.\d\w*|\+\+|--|&&|\|\||<<|>>|[-+*/<>=!&|^%]=|\S/g,
    ) ?? []
  );
}

/** A literal's text between its delimiters, and where it meets a line */
function parts(raw: string): { text: string; open: boolean; close: boolean } {
  const close = raw.endsWith("${") ? 2 : 1;
  return {
    text: raw.slice(1, -close),
    open: raw[0] === "`",
    close: close === 1,
  };
}

describe("the shaders of the custom layers, tightened", () => {
  it("finds shaders in every layer that has them", () => {
    const found = LAYERS.filter(
      (name) =>
        glslLiterals(readFileSync(join(UI_DIR, name), "utf8")).length > 0,
    );
    expect(found).toEqual(
      expect.arrayContaining(["heatCloudShaders.ts", "replayAllLayer.ts"]),
    );
  });

  it.each(LAYERS)(
    "%s: are the same tokens as written, each directive on a line of its own",
    (name) => {
      const source = readFileSync(join(UI_DIR, name), "utf8");
      for (const { raw } of glslLiterals(source)) {
        const { text, open, close } = parts(raw);
        const tight = tightenGlsl(text, open, close);
        expect(tokens(tight)).toEqual(tokens(text));
        // A directive is a line, the same as written, and nothing else is
        // on it
        const directives = (glsl: string): string[] =>
          glsl
            .split("\n")
            .map((line) => line.trim().replace(/[ \t]+/g, " "))
            .filter((line) => line.includes("#"));
        expect(directives(tight)).toEqual(directives(text));
        for (const line of tight.split("\n")) {
          if (line.includes("#")) expect(line).toMatch(/^#/);
        }
      }
    },
  );

  it("are shorter by their line breaks", () => {
    // What the joined lines saved, in the shaders of the heat cloud
    const source = readFileSync(join(UI_DIR, "heatCloudShaders.ts"), "utf8");
    const breaks = (glsl: string): number => glsl.split("\n").length - 1;
    let written = 0;
    let shipped = 0;
    for (const { raw } of glslLiterals(source)) {
      const { text, open, close } = parts(raw);
      written += breaks(text);
      shipped += breaks(tightenGlsl(text, open, close));
    }
    expect(shipped).toBeLessThan(written / 4);
  });

  it.each(LAYERS)("%s: is left as it is outside its shaders", (name) => {
    const source = readFileSync(join(UI_DIR, name), "utf8");
    const tight = tightenShaders(source);
    // Every literal is tightened in place: what lies between them is
    // the source's own, byte for byte
    const literals = glslLiterals(source);
    const tightLiterals = glslLiterals(tight);
    expect(tightLiterals).toHaveLength(literals.length);
    let at = 0;
    let tightAt = 0;
    literals.forEach(({ start, end }, i) => {
      const other = tightLiterals[i]!;
      expect(tight.slice(tightAt, other.start)).toBe(source.slice(at, start));
      at = end;
      tightAt = other.end;
    });
    expect(tight.slice(tightAt)).toBe(source.slice(at));
  });
});

describe("glslLiterals", () => {
  it("gives each part with its delimiters, as the source writes it", () => {
    const source = "const s = `uniform float a;${b}\nvoid main() {}${c}`;";
    expect(glslLiterals(source).map(({ raw }) => raw)).toEqual([
      "`uniform float a;${",
      "}\nvoid main() {}${",
      "}`",
    ]);
    for (const { start, end, raw } of glslLiterals(source)) {
      expect(source.slice(start, end)).toBe(raw);
    }
  });

  it("reads TypeScript, and skips template literal types", () => {
    const source = [
      "type T = { a: number };",
      "const f = <K extends string>(k: K): K => k;",
      "const v = (x as unknown as T) satisfies T;",
      "type G = `gl_${number}`;",
      "const g = (n: number): `uniform ${number}` => `gl_${n}` as const;",
      "export const s: string = `uniform vec2 u;` as const;",
    ].join("\n");
    expect(glslLiterals(source).map(({ raw }) => raw)).toEqual([
      "`gl_${",
      "}`",
      "`uniform vec2 u;`",
    ]);
  });

  it("finds a literal inside another one's expression, and tagged ones", () => {
    const source =
      "const s = `${`uniform int i;`} gl_Position`; const t = tag`gl_x`;";
    expect(glslLiterals(source).map(({ raw }) => raw)).toEqual([
      "`${",
      "} gl_Position`",
      "`uniform int i;`",
      "`gl_x`",
    ]);
  });

  it("judges a literal by its text, never by what it interpolates", () => {
    expect(glslLiterals("const s = `a ${gl_x} b`;")).toEqual([]);
  });

  it.each([
    ["decorators", "@dec class A { @dec m() { return `gl_a`; } }"],
    ["a decorated export", "@dec export class B { s = `gl_b`; }"],
    [
      "accessor fields",
      "class C { accessor y = `gl_c`; static accessor z = 2; }",
    ],
    ["deferred imports", 'import defer * as ns from "./x";\nconst s = `gl_d`;'],
    [
      "source phase imports",
      'import source w from "./x.wasm";\nconst s = `gl_e`;',
    ],
    ["using declarations", "{ using r = res(); const s = `gl_f`; }"],
    [
      "import attributes",
      'import j from "./a.json" with { type: "json" };\nconst s = `gl_g`;',
    ],
  ])("reads %s, as TypeScript and esbuild do", (_name, source) => {
    expect(glslLiterals(source)).toHaveLength(1);
  });

  it("finds nothing in a source that does not parse, and leaves it as written", () => {
    const broken = "const = `gl_Position`;";
    expect(glslLiterals(broken)).toEqual([]);
    expect(tightenShaders(broken)).toBe(broken);
  });

  it("leaves a syntax error to esbuild, which names the file and the line", async () => {
    const source = "const ok = `uniform float a;`;\nconst = 1;\n";
    const path = join(mkdtempSync(join(tmpdir(), "glsl-")), "brokenLayer.ts");
    writeFileSync(path, source);
    const failure = await build({
      entryPoints: [path],
      write: false,
      logLevel: "silent",
      plugins: [
        {
          name: "shaders",
          setup(plugin) {
            plugin.onLoad({ filter: /brokenLayer\.ts$/ }, () => ({
              contents: tightenShaders(source),
              loader: "ts",
            }));
          },
        },
      ],
    }).catch((error: unknown) => error as BuildFailure);
    const [error] = (failure as BuildFailure).errors;
    expect(error?.location?.file).toMatch(/brokenLayer\.ts$/);
    expect(error?.location?.line).toBe(2);
  });
});

describe("tightenGlsl", () => {
  it("takes out the spaces around the punctuation that separates tokens", () => {
    expect(tightenGlsl("  x = f( a , b ) ;", true, true)).toBe("x=f(a,b);");
    expect(tightenGlsl("if (a < b && c) { d = e ? f : g; }", true, true)).toBe(
      "if(a<b&&c){d=e?f:g;}",
    );
  });

  it("keeps the space of a negation after a minus, and around + and -", () => {
    // "a--b" would be a decrement
    expect(tightenGlsl("a - -b", true, true)).toBe("a - -b");
    expect(tightenGlsl("c = a + +b;", true, true)).toBe("c=a + +b;");
  });

  it("leaves a directive as it is written", () => {
    // "#define A(b)" would be a macro of a parameter
    expect(tightenGlsl("#define A (b)", true, true)).toBe("#define A (b)");
    expect(tightenGlsl("x = 1;\n  #ifdef A\ny;", true, true)).toBe(
      "x=1;\n#ifdef A\ny;",
    );
  });

  it("takes out the comments, a block one across lines included", () => {
    expect(tightenGlsl("a;/* one\ntwo */b;\nc;", true, true)).toBe("a;b;c;");
    expect(tightenGlsl("a/* one\ntwo */b;", true, true)).toBe("a b;");
    // The comment that opens first wins, a // inside a block one included
    expect(tightenGlsl("a; /* // */ b; // c */\nd;", true, true)).toBe(
      "a;b;d;",
    );
  });

  it("keeps the space next to an interpolation, which may meet a word", () => {
    // `uniform ${type} u;`: the text around the value is not a line's end
    expect(tightenGlsl("uniform ", true, false)).toBe("uniform ");
    expect(tightenGlsl(" u;\n  v;", false, true)).toBe(" u;\nv;");
  });

  it("runs the lines together, with a space only between two words", () => {
    expect(
      tightenGlsl(
        "void main() {\n  float a = 1.0;\n  a = a\n    - b;\n}",
        true,
        true,
      ),
    ).toBe("void main(){float a=1.0;a=a - b;}");
    expect(tightenGlsl("uniform\nfloat u;", true, true)).toBe(
      "uniform float u;",
    );
    // Neither side punctuation of one character: "a\n-b" and "a\n.5"
    // stay apart, "-\n-" never becomes a decrement
    expect(tightenGlsl("a\n-b;\nc = d -\n-e;", true, true)).toBe(
      "a -b;c=d - -e;",
    );
    // Empty lines, and the comments that leave one, go
    expect(tightenGlsl("a;\n\n  // b\n\nc;", true, true)).toBe("a;c;");
  });

  it("keeps a directive on a line of its own", () => {
    expect(
      tightenGlsl(
        "#version 300 es\nprecision highp float;\n#define A (b)\nout vec4 c;\n\n#ifdef A\nx;\n#endif\n",
        true,
        true,
      ),
    ).toBe(
      "#version 300 es\nprecision highp float;\n#define A (b)\nout vec4 c;\n#ifdef A\nx;\n#endif\n",
    );
  });

  it("keeps a directive's continued lines in it, and nothing else", () => {
    expect(
      tightenGlsl("#define A(x) x\\\n  + 1\nfloat y = A(2);\n", true, true),
    ).toBe("#define A(x) x\\\n + 1\nfloat y=A(2);");
    // A comment across lines does not end it either
    expect(
      tightenGlsl("#define A 1 /* x\n y */ + 2\nfloat y;", true, true),
    ).toBe("#define A 1 + 2\nfloat y;");
  });

  it("keeps the line breaks next to an interpolation, whose value may be a directive", () => {
    // `${MARKS_VERTEX}` on a line of its own
    expect(tightenGlsl("\n  a;\n  b;\n", false, true)).toBe("\na;b;");
    expect(tightenGlsl("a;\n  b;\n", true, false)).toBe("a;b;\n");
    expect(tightenGlsl("a;\nb;", false, false)).toBe("a;\nb;");
  });
});

describe("assertExpectedOutputs", () => {
  const outputs = (...names: string[]) => ({
    outputs: Object.fromEntries(
      names.map((name) => [`flown/static/${name}`, {}]),
    ),
  });

  it("passes the files the site publishes, whatever else is written", () => {
    expect(() =>
      assertExpectedOutputs(
        [outputs("a.bundle.js", "a.bundle.js.map"), outputs("b.bundle.js")],
        ["b.bundle.js", "a.bundle.js"],
      ),
    ).not.toThrow();
  });

  it("fails on a chunk the site does not publish, and on one missing", () => {
    expect(() =>
      assertExpectedOutputs(
        [outputs("a.bundle.js", "shared.bundle.js", "shared.bundle2.js")],
        ["a.bundle.js", "shared.bundle.js"],
      ),
    ).toThrow(/wrote a\.bundle\.js, shared\.bundle\.js, shared\.bundle2\.js/);
    expect(() =>
      assertExpectedOutputs(
        [outputs("a.bundle.js"), undefined],
        ["a.bundle.js", "b.bundle.js"],
      ),
    ).toThrow(/publishes a\.bundle\.js, b\.bundle\.js/);
  });
});
