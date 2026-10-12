/**
 * The parts of build.js that do no building: the shaders written as a
 * minified build ships them, the sizes of the files and what esbuild
 * wrote, the composition of a bundle and its comparison with an earlier
 * build, and the flags of the command. build.js runs a build as it is
 * imported, so what is tested lives here
 * (tests/frontend/unit/glsl.test.ts, tests/frontend/unit/buildHelpers.test.ts).
 */

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parse } from "@babel/parser";
import { isNode, VISITOR_KEYS } from "@babel/types";

/**
 * GLSL as a minified build ships it: `text` without its comments, and each
 * line without its indentation and the spaces around the punctuation that
 * separates tokens anyway. Not around + and -, where "a - -b" would become
 * a decrement, and not in a directive, where "#define A (b)" would become a
 * macro of a parameter. The lines stay lines, for the preprocessor and for
 * the line numbers a compiler's error names. `open` and `close` say
 * whether the text starts or ends a line rather than meets an
 * interpolation, whose value a space may separate from a word.
 * @param {string} text
 * @param {boolean} open
 * @param {boolean} close
 * @returns {string}
 */
export function tightenGlsl(text, open, close) {
  const lines = text
    // Whichever comment opens first, a block one as a space or the breaks
    // of the lines it spans
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (comment) =>
      comment.startsWith("//") ? "" : comment.replace(/[^\n]+/g, " "),
    )
    .split("\n");
  return lines
    .map((line, i) => {
      let tight = line.replace(/[ \t]+/g, " ");
      if (!/^ ?#/.test(tight)) {
        tight = tight.replace(/ ?([=,;(){}[\]*/<>?:&|!]) ?/g, "$1");
      }
      if (i > 0 || open) tight = tight.trimStart();
      if (i < lines.length - 1 || close) tight = tight.trimEnd();
      return tight;
    })
    .join("\n");
}

/**
 * The parts of the template literals of `source` that hold GLSL, in the
 * order they are written: the text of a literal without substitutions, or
 * of the head and each span of one with them. A literal is taken for GLSL
 * where its text holds "gl_" or "uniform ", and only its text, never the
 * expressions it interpolates. None where `source` does not parse.
 * @param {string} source
 * @returns {{start: number, end: number, raw: string}[]}
 */
export function glslLiterals(source) {
  return literalParts(source, (text) => /gl_|uniform /.test(text));
}

/**
 * The parts of the template literals of `source` whose text `accept`
 * takes, as glslLiterals gives them
 * @param {string} source
 * @param {(text: string) => boolean} accept
 * @returns {{start: number, end: number, raw: string}[]}
 */
function literalParts(source, accept) {
  /** @type {{start: number, end: number, raw: string}[]} */
  const parts = [];
  for (const { quasis } of templateLiterals(source)) {
    const text = quasis
      .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
      .join("");
    if (!accept(text)) continue;
    // A quasi spans its text alone; a part runs from the backtick or the
    // brace before it to the backtick or the "${" after it. The parser
    // gives every node its offsets.
    quasis.forEach(({ start, end }, i) => {
      if (start == null || end == null) return;
      const from = start - 1;
      const to = end + (i === quasis.length - 1 ? 1 : 2);
      parts.push({ start: from, end: to, raw: source.slice(from, to) });
    });
  }
  return parts;
}

/**
 * The syntax the parser reads besides TypeScript's own: what TypeScript
 * and esbuild accept in a .ts file, so a source the build compiles never
 * fails here
 * @type {import("@babel/parser").ParserPlugin[]}
 */
const PARSER_PLUGINS = [
  "typescript",
  "decorators",
  "decoratorAutoAccessors",
  "deferredImportEvaluation",
  "sourcePhaseImports",
];

/**
 * The template literals of the TypeScript `source`, outer ones before
 * those they interpolate, without the template literal types. The parser
 * of Babel reads the types without the TypeScript compiler, whose API
 * TypeScript 7 only exports as an unstable preview. None where `source`
 * does not parse: the file is then left as written, and esbuild (or
 * Vitest) reports the error with its file, line and the code around it.
 * @param {string} source
 * @returns {import("@babel/types").TemplateLiteral[]}
 */
function templateLiterals(source) {
  let file;
  try {
    file = parse(source, { sourceType: "module", plugins: PARSER_PLUGINS });
  } catch {
    return [];
  }
  /** @type {import("@babel/types").TemplateLiteral[]} */
  const literals = [];
  /** @param {import("@babel/types").Node} node */
  const visit = (node) => {
    // A template literal type (`o${number}`) is a type, not a string the
    // code builds, and holds none of those; the TypeScript compiler API
    // this replaces did not count them either
    if (node.type === "TSLiteralType") return;
    if (node.type === "TemplateLiteral") literals.push(node);
    // The child nodes alone, not the comments or the other fields
    for (const key of VISITOR_KEYS[node.type] ?? []) {
      /** @type {unknown} */
      const child = Reflect.get(node, key);
      for (const each of Array.isArray(child) ? child : [child]) {
        if (isNode(each)) visit(each);
      }
    }
  };
  visit(file.program);
  return literals;
}

/**
 * `source` with the GLSL of its template literals tightened (tightenGlsl):
 * what the shader plugin of build.js hands esbuild for a ui/*Layer.ts or
 * ui/*Shaders.ts.
 * @param {string} source
 * @returns {string}
 */
export function tightenShaders(source) {
  // From the end, so the offsets of those before stay where they were
  const parts = glslLiterals(source).sort((a, b) => b.end - a.end);
  let contents = source;
  for (const { start, end, raw } of parts) {
    // Between the backtick or the brace it opens with and the backtick or
    // "${" it closes with
    const close = raw.endsWith("${") ? 2 : 1;
    const text = tightenGlsl(raw.slice(1, -close), raw[0] === "`", close === 1);
    contents =
      contents.slice(0, start + 1) + text + contents.slice(end - close);
  }
  return contents;
}

/**
 * Fail on markup whose white space is not free to collapse: a <pre> or a
 * <textarea> keeps it, and so does an attribute value that spans a line.
 * Such markup would read differently once tightenMarkup put it on one
 * line, so the build stops instead of shipping it.
 * @param {string} text - The text of a template literal, without the
 *   expressions it interpolates
 * @param {string} path
 */
function assertTightenable(text, path) {
  const keeps = /<(pre|textarea)\b/i.exec(text);
  if (keeps) {
    throw new Error(
      `${path}: a template literal holds <${keeps[1]}>, whose white space ` +
        "tightenMarkup would collapse",
    );
  }
  if (/=\s*(["'])[^"'<>]*\n/.test(text)) {
    throw new Error(
      `${path}: an attribute value of a template literal spans a line, ` +
        "which tightenMarkup would put on one",
    );
  }
}

/**
 * `source` with the markup of its template literals on one line: each line
 * break and the indentation after it as a single space, which HTML reads
 * the same, as it collapses every run of white space outside an attribute
 * value into one. What the markup plugin of build.js hands esbuild for
 * utils/htmlGenerators.ts, whose popups are indented literals, and whose
 * attribute values never span a line.
 * @param {string} source
 * @param {string} [path]
 * @returns {string}
 */
export function tightenMarkup(source, path = "markup.ts") {
  // From the end, so the offsets of those before stay where they were
  const parts = literalParts(source, (text) => {
    if (!/<\/?[a-z]/.test(text)) return false;
    assertTightenable(text, path);
    return true;
  }).sort((a, b) => b.end - a.end);
  let contents = source;
  for (const { start, end, raw } of parts) {
    contents =
      contents.slice(0, start) +
      raw.replace(/\n[ \t]*/g, " ") +
      contents.slice(end);
  }
  return contents;
}

/** A number of SVG path data, with what separates it from the one before */
const PATH_NUMBER = /^[\s,]*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/;

/**
 * The path data `second` drawn after `first` in one path, as each draws as
 * a path of its own: what the Lucide plugin of build.js makes of an icon's
 * paths. A path that starts with a relative moveto (`m`) starts at its
 * point as if it were absolute, and the pairs after that point are
 * relative linetos; after a subpath the same `m` is relative to where that
 * one ends, which drew Lucide's X as one stroke. So it is written as an
 * absolute moveto, with an `l` for the pairs after it.
 * @param {string} first
 * @param {string} second
 * @returns {string}
 */
export function joinPathData(first, second) {
  const data = second.trim();
  if (!data.startsWith("m")) return first + data;
  let rest = data.slice(1);
  /** @type {string[]} */
  const point = [];
  for (let i = 0; i < 2; i++) {
    const number = PATH_NUMBER.exec(rest);
    if (!number?.[1]) throw new Error(`Unexpected path data: ${second}`);
    point.push(number[1]);
    rest = rest.slice(number[0].length);
  }
  rest = rest.replace(/^[\s,]+/, "");
  const lines = PATH_NUMBER.test(rest) ? "l" : "";
  return `${first}M${point.join(" ")}${lines}${rest}`;
}

/**
 * Format bytes to human-readable size
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Size of a file as written and gzipped at the highest level
 * @param {string} path
 * @returns {{raw: number, gzip: number}}
 */
export function measure(path) {
  const content = readFileSync(path);
  return {
    raw: content.length,
    gzip: gzipSync(content, { level: 9 }).length,
  };
}

/**
 * Fail the build when it wrote any JavaScript but `expected`.
 *
 * The site publishes the bundles by name (SITE_FILES in
 * flown/site_assets.py) and the page preloads the shared chunk by
 * name. A module the lazy entry points share without the app, another
 * entry point or a second dynamic import would make esbuild write further
 * chunks, all called shared.bundle.js; that has to be a decision about
 * naming, not a surprise.
 * @param {({outputs: Record<string, unknown>} | undefined)[]} metafiles
 * @param {string[]} expected - The names of the files the site publishes
 */
export function assertExpectedOutputs(metafiles, expected) {
  const written = metafiles
    .flatMap((metafile) => Object.keys(metafile?.outputs ?? {}))
    .filter((path) => path.endsWith(".js"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .sort();
  const wanted = [...expected].sort();
  if (written.join() !== wanted.join()) {
    throw new Error(
      `the build wrote ${written.join(", ")} but the site publishes ` +
        `${wanted.join(", ")}; see chunkNames in build.js`,
    );
  }
}

/**
 * @typedef {object} Output
 * @property {number} bytes
 * @property {Record<string, {bytesInOutput: number}>} inputs
 */

/**
 * The output of a metafile that is the file `fileName`, whichever
 * directory it was written to
 * @param {{outputs: Record<string, Output>}} metafile
 * @param {string} fileName
 * @returns {Output | undefined}
 */
export function outputNamed(metafile, fileName) {
  return Object.entries(metafile.outputs).find(([path]) =>
    path.endsWith(`/${fileName}`),
  )?.[1];
}

/**
 * The inputs that take the most of an output, largest first
 * @param {Output} output
 * @param {number} [count]
 * @returns {[input: string, bytes: number][]}
 */
export function largestInputs(output, count = 10) {
  return Object.entries(output.inputs)
    .map(
      ([input, { bytesInOutput }]) =>
        /** @type {[string, number]} */ ([input, bytesInOutput]),
    )
    .sort(([, a], [, b]) => b - a)
    .slice(0, count);
}

/**
 * What changed in the output `fileName` from the build of `before` to the
 * one of `after`: the bytes of every input that grew, shrank, came or
 * went, the largest change first, and of the output as a whole
 * @param {{outputs: Record<string, Output>}} before
 * @param {{outputs: Record<string, Output>}} after
 * @param {string} fileName
 * @returns {{total: number, inputs: [input: string, delta: number][]}}
 */
export function inputDeltas(before, after, fileName) {
  const old = outputNamed(before, fileName);
  const now = outputNamed(after, fileName);
  /** @type {Map<string, number>} */
  const deltas = new Map();
  for (const [input, { bytesInOutput }] of Object.entries(old?.inputs ?? {})) {
    deltas.set(input, -bytesInOutput);
  }
  for (const [input, { bytesInOutput }] of Object.entries(now?.inputs ?? {})) {
    deltas.set(input, (deltas.get(input) ?? 0) + bytesInOutput);
  }
  return {
    total: (now?.bytes ?? 0) - (old?.bytes ?? 0),
    inputs: [...deltas]
      .filter(([, delta]) => delta !== 0)
      .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a)),
  };
}

/**
 * A budget a bundle does not fit
 * @typedef {object} Overrun
 * @property {string} what The files, joined
 * @property {"raw" | "gzip"} kind
 * @property {number} size In bytes, NaN where the files could not be measured
 * @property {number} budget In bytes
 */

/**
 * The closing lines of a build over budget: each budget it exceeds, with
 * the bytes over, so a failed job ends with them rather than with the
 * breakdowns printed after the table
 * @param {Overrun[]} overruns
 * @returns {string[]}
 */
export function overrunSummary(overruns) {
  return [
    "❌ Bundle size budget exceeded:",
    ...overruns.map(({ what, kind, size, budget }) =>
      Number.isNaN(size)
        ? `  ${what}: could not be measured`
        : `  ${what}: ${size} B ${kind === "gzip" ? "gzipped" : "raw"}, ` +
          `budget ${budget} B, ${size - budget} B over`,
    ),
  ];
}

/**
 * The flags of `node build.js`: `--watch`, `--metafile [path]`, which
 * writes esbuild's metafile (to `defaultMetafile` without a path), and
 * `--compare <path>`, which prints what changed from the build of an
 * earlier metafile
 * @param {string[]} args - process.argv without the first two
 * @param {string} defaultMetafile
 * @returns {{watch: boolean, metafile: string | null, compare: string | null}}
 */
export function parseBuildArgs(args, defaultMetafile) {
  /** @param {number} at */
  const value = (at) => {
    const next = args[at + 1];
    return next !== undefined && !next.startsWith("--") ? next : null;
  };
  const metafileAt = args.indexOf("--metafile");
  const compareAt = args.indexOf("--compare");
  const compare = compareAt >= 0 ? value(compareAt) : null;
  if (compareAt >= 0 && !compare) {
    throw new Error("--compare needs the path of a metafile");
  }
  return {
    watch: args.includes("--watch"),
    metafile: metafileAt >= 0 ? (value(metafileAt) ?? defaultMetafile) : null,
    compare,
  };
}
