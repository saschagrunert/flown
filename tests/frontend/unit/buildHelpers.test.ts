/**
 * What build.js prints of the bundles and the flags it takes, and the
 * popups' markup it tightens (scripts/build-helpers.js). The shaders and
 * the outputs the site publishes are in glsl.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  inputDeltas,
  joinPathData,
  largestInputs,
  overrunSummary,
  parseBuildArgs,
  tightenMarkup,
} from "../../../scripts/build-helpers.js";

const FRONTEND_DIR = join(__dirname, "../../../flown/frontend");

/** A metafile of one output and the bytes each input takes of it */
const metafile = (name: string, inputs: Record<string, number>) => ({
  outputs: {
    [`flown/static/${name}`]: {
      bytes: Object.values(inputs).reduce((sum, bytes) => sum + bytes, 0),
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([input, bytesInOutput]) => [
          input,
          { bytesInOutput },
        ]),
      ),
    },
  },
});

describe("formatBytes", () => {
  it("names bytes, kilobytes and megabytes, and a change that shrank", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(-2048)).toBe("-2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
  });
});

describe("largestInputs", () => {
  it("lists the modules that take the most of a bundle first", () => {
    const { outputs } = metafile("a.js", { x: 5, y: 50, z: 20 });
    const output = outputs["flown/static/a.js"]!;
    expect(largestInputs(output, 2)).toEqual([
      ["y", 50],
      ["z", 20],
    ]);
  });
});

describe("inputDeltas", () => {
  it("names what grew, shrank, came and went, the largest change first", () => {
    const before = metafile("a.js", { kept: 10, grown: 10, gone: 30 });
    const after = metafile("a.js", { kept: 10, grown: 15, new: 100 });
    expect(inputDeltas(before, after, "a.js")).toEqual({
      total: 125 - 50,
      inputs: [
        ["new", 100],
        ["gone", -30],
        ["grown", 5],
      ],
    });
  });

  it("takes a bundle one of the builds lacks for an empty one", () => {
    const after = metafile("a.js", { only: 7 });
    expect(inputDeltas({ outputs: {} }, after, "a.js")).toEqual({
      total: 7,
      inputs: [["only", 7]],
    });
  });
});

describe("parseBuildArgs", () => {
  it("reads the flags, with a default path for the metafile", () => {
    expect(parseBuildArgs([], "meta.json")).toEqual({
      watch: false,
      metafile: null,
      compare: null,
    });
    expect(parseBuildArgs(["--metafile", "--watch"], "meta.json")).toEqual({
      watch: true,
      metafile: "meta.json",
      compare: null,
    });
    expect(
      parseBuildArgs(
        ["--metafile", "out.json", "--compare", "old.json"],
        "meta.json",
      ),
    ).toEqual({ watch: false, metafile: "out.json", compare: "old.json" });
  });

  it("asks for the metafile to compare with", () => {
    expect(() => parseBuildArgs(["--compare"], "meta.json")).toThrow(
      /--compare needs the path of a metafile/,
    );
  });
});

describe("overrunSummary", () => {
  it("names each budget a bundle exceeds and the bytes over", () => {
    expect(
      overrunSummary([
        {
          what: "features.bundle.js",
          kind: "gzip",
          size: 53_288,
          budget: 53_248,
        },
        {
          what: "wrapped.bundle.js",
          kind: "raw",
          size: 44_100,
          budget: 44_032,
        },
        {
          what: "vendor/html-to-image.mjs",
          kind: "raw",
          size: NaN,
          budget: 14_336,
        },
      ]),
    ).toEqual([
      "❌ Bundle size budget exceeded:",
      "  features.bundle.js: 53288 B gzipped, budget 53248 B, 40 B over",
      "  wrapped.bundle.js: 44100 B raw, budget 44032 B, 68 B over",
      "  vendor/html-to-image.mjs: could not be measured",
    ]);
  });
});

describe("tightenMarkup", () => {
  it("puts the markup of a literal on one line and leaves the code be", () => {
    const source = [
      "// A comment",
      "const a = 1;",
      "const html = `",
      "    <div>",
      "        <span>${a}</span>",
      "    </div>`;",
      "const text = `two",
      "lines`;",
    ].join("\n");

    expect(tightenMarkup(source)).toBe(
      [
        "// A comment",
        "const a = 1;",
        "const html = ` <div> <span>${a}</span> </div>`;",
        "const text = `two",
        "lines`;",
      ].join("\n"),
    );
  });

  it("changes only the white space of the popups", () => {
    const source = readFileSync(
      join(FRONTEND_DIR, "utils/htmlGenerators.ts"),
      "utf8",
    );
    const tight = tightenMarkup(source, "htmlGenerators.ts");

    expect(tight.length).toBeLessThan(source.length - 300);
    expect(tight.replace(/\s+/g, "")).toBe(source.replace(/\s+/g, ""));
    expect(tight).toContain('` <div class="popup-container');
  });

  it("refuses markup whose white space would change", () => {
    const pre = "const a = `<div>\n  <pre>x\n  y</pre></div>`;";
    const attribute = 'const b = `<div title="one\n  two">x</div>`;';
    const expression = 'const c = (v: string) => `<p title="${v}\n  w">x</p>`;';

    expect(() => tightenMarkup(pre, "a.ts")).toThrow(/a\.ts: .*<pre>/);
    expect(() => tightenMarkup(attribute, "b.ts")).toThrow(/spans a line/);
    expect(() => tightenMarkup(expression, "c.ts")).toThrow(/spans a line/);
  });

  it("lets an attribute value end before the line breaks", () => {
    const source = 'const a = `<div\n  class="x"\n  title="${1}">y</div>`;';

    expect(tightenMarkup(source)).toBe(
      'const a = `<div class="x" title="${1}">y</div>`;',
    );
  });
});

describe("the popups the unit tests import", () => {
  it("are the tightened ones a minified build ships", async () => {
    const { generateAirportPopupHtml } =
      await import("../../../flown/frontend/utils/htmlGenerators");
    expect(String(generateAirportPopupHtml)).not.toMatch(/\n\s+</);
  });
});

describe("joinPathData", () => {
  it("draws a relative start where it drew as a path of its own", () => {
    // Lucide's X: two strokes, not one from the end of the first
    expect(joinPathData("M18 6 6 18", "m6 6 12 12")).toBe(
      "M18 6 6 18M6 6l12 12",
    );
  });

  it("keeps the pairs after a relative start relative, and an absolute start as it is", () => {
    expect(joinPathData("M1 1h2", "m-1.5.5,2 2-3 1")).toBe(
      "M1 1h2M-1.5 .5l2 2-3 1",
    );
    expect(joinPathData("M1 1h2", "m3 4")).toBe("M1 1h2M3 4");
    expect(joinPathData("M1 1h2", "M3 4h5")).toBe("M1 1h2M3 4h5");
    expect(joinPathData("M1 1h2", "m3 4a2 2 0 0 1 2 2")).toBe(
      "M1 1h2M3 4a2 2 0 0 1 2 2",
    );
  });

  it("refuses path data it cannot read", () => {
    expect(() => joinPathData("M1 1", "m3")).toThrow("Unexpected path data");
  });
});
