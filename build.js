#!/usr/bin/env node

/**
 * Build script for Flown JavaScript modules
 * Uses esbuild to bundle the TypeScript sources into ES modules
 */

import * as esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import {
  assertExpectedOutputs,
  formatBytes,
  inputDeltas,
  joinPathData,
  largestInputs,
  measure,
  outputNamed,
  overrunSummary,
  parseBuildArgs,
  tightenMarkup,
  tightenShaders,
} from "./scripts/build-helpers.js";
import {
  buildBanner as makeBanner,
  computeSourceHash,
} from "./scripts/source-hash.js";
import {
  copyCountryFlags,
  copyVendorAssets,
  VENDOR_FILES,
  VENDOR_MODULES,
} from "./scripts/vendor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATIC_DIR = join(__dirname, "flown/static");
const FRONTEND_DIR = join(__dirname, "flown/frontend");

// `--metafile [path]` keeps esbuild's account of what went into each
// bundle (bundle-meta.json in the checkout without a path, gitignored and
// outside flown/static, whose JSON files the wheel packages), and
// `--compare <path>` prints what changed in each bundle since the build
// that wrote that file (see scripts/README.md)
const args = parseBuildArgs(
  process.argv.slice(2),
  join(__dirname, "bundle-meta.json"),
);
const isWatch = args.watch;
const isDevelopment = process.env.NODE_ENV === "development" || isWatch;
const minify = !isDevelopment;

// A watch build stamps no hash: the hash of when it started would stay in
// the bundles while the sources it rebuilds from change, so the e2e site
// check and the generator would take a site built from edited sources for
// one of the sources on disk. Without one, both say it is no build of the
// checkout; `npm run build` makes it one again.
const sourceHash = isWatch ? "dev-watch" : computeSourceHash();
const buildBanner = makeBanner(sourceHash);

/**
 * Leave MapLibre out of the bundles and import the vendored module instead,
 * and html-to-image with it.
 *
 * It is three quarters of a megabyte that changes only when the dependency
 * is bumped, so it stays a file of its own that the browser caches apart
 * from the app. It also has to: MapLibre finds its worker relative to its
 * own URL (see scripts/vendor.js), which a copy inside the bundle would not
 * have. The bundles sit next to vendor/, so the path is the same for all.
 * @type {import("esbuild").Plugin}
 */
const maplibreVendorPlugin = {
  name: "maplibre-vendor",
  setup(build) {
    build.onResolve({ filter: /^maplibre-gl$/ }, () => ({
      path: "./vendor/maplibre-gl.mjs",
      external: true,
    }));
    // html-to-image likewise: only an export needs it, so the app imports
    // it on the first one (ui/mapExport.ts). Pointing the import() at the
    // vendored module keeps it out of the bundles without making esbuild
    // write a second chunk, which would need a name (assertExpectedOutputs).
    build.onResolve({ filter: /^html-to-image$/ }, () => ({
      path: "./vendor/html-to-image.mjs",
      external: true,
    }));
  },
};

/**
 * Leave the year decoder out of the bundles as well. The app decodes the
 * year files in a worker, which is a build of its own (workerBuildOptions);
 * where the worker cannot be used, the app imports the decoder from that
 * same file (services/yearDecoder.ts). Without this, esbuild would write the
 * decoder a second time, as a chunk of the app.
 * @type {import("esbuild").Plugin}
 */
const yearWorkerPlugin = {
  name: "year-worker",
  setup(build) {
    build.onResolve({ filter: /^\.\/yearWorker$/ }, (args) =>
      args.kind === "dynamic-import"
        ? { path: `./${WORKER_BUNDLE}`, external: true }
        : undefined,
    );
  },
};

/**
 * Take utils/constants.ts for a module without side effects in the year
 * worker's bundle, which uses the knot of it alone (the heat lines): the
 * worker reaches it through helpers of the heat lines (utils/mapHelpers.ts,
 * utils/geometry.ts), and esbuild kept 0.85 KB of constants that it cannot
 * tell are free of side effects (MAP_LAYERS and HEATMAP_LAYER_IDS, sums of
 * other constants). With no import of it used, the module is left out; a
 * constant made of others is marked pure there, so it is left out as well.
 * @type {import("esbuild").Plugin}
 */
const pureConstantsPlugin = {
  name: "pure-constants",
  setup(build) {
    build.onResolve({ filter: /\/constants$/ }, async (args) => {
      if (args.pluginData === "pure-constants") return undefined;
      const { path, errors } = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: "pure-constants",
      });
      return errors.length > 0 ? { errors } : { path, sideEffects: false };
    });
  },
};

/**
 * Write the shaders of the custom layers (ui/*Layer.ts, and
 * ui/*Shaders.ts where a layer keeps them apart) as a minified
 * build ships them (tightenShaders and tightenGlsl in
 * scripts/build-helpers.js). esbuild leaves a template literal as it is
 * written, and their GLSL, some 12 KB of the feature bundle, was a sixth
 * indentation and spaces. A template literal is taken for GLSL where its
 * text holds "gl_" or "uniform ", and only its text is changed, never the
 * expressions it interpolates. Development builds read the shaders as they
 * are written; tests/frontend/unit/glsl.test.ts checks that the tightened
 * ones of every layer are the same tokens as written.
 * @type {import("esbuild").Plugin}
 */
const shaderPlugin = {
  name: "shaders",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]ui[\\/]\w+(?:Layer|Shaders)\.ts$/ },
      async (args) => {
        const source = await readFile(args.path, "utf8");
        return { contents: tightenShaders(source), loader: "ts" };
      },
    );
  },
};

/**
 * Each Lucide icon the page draws (utils/icons.ts) with its run of plain
 * paths as one: a path of several subpaths strokes as the paths do one by
 * one, with the outline the page draws its icons in, and each path of a
 * node list was a `["path",{d:"..."}]` of its own, 77 of them in the first
 * visit. Each icon module is also no longer listed by name under the
 * license the bundle carries, which comes with the package's own module
 * (lucide.mjs) as before. Minified builds only.
 * @type {import("esbuild").Plugin}
 */
const lucidePathsPlugin = {
  name: "lucide-paths",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]lucide[\\/]dist[\\/]esm[\\/]icons[\\/][\w-]+\.mjs$/ },
      async (args) => {
        /** @type {[string, Record<string, string>][]} */
        const nodes = (await import(pathToFileURL(args.path).href)).default;
        /** A path of nothing but its outline */
        const plain = (/** @type {[string, Record<string, string>]} */ node) =>
          node[0] === "path" && Object.keys(node[1]).join() === "d";
        /** @type {[string, Record<string, string>][]} */
        const merged = [];
        for (const node of nodes) {
          const last = merged.at(-1);
          if (last && plain(last) && plain(node)) {
            last[1] = {
              d: joinPathData(last[1]["d"] ?? "", node[1]["d"] ?? ""),
            };
          } else {
            // A copy: the module's own list stays as it is
            merged.push([node[0], { ...node[1] }]);
          }
        }
        return {
          contents: `export default ${JSON.stringify(merged)};`,
          loader: "js",
        };
      },
    );
  },
};

/**
 * The popups of utils/htmlGenerators.ts without the line breaks and the
 * indentation of their template literals (tightenMarkup), which esbuild
 * keeps as they are written. Minified builds only; the unit tests run the
 * same transform (vitest.config.js), and markup whose white space matters
 * (a <pre>, an attribute value over two lines) fails the build.
 * @type {import("esbuild").Plugin}
 */
const markupPlugin = {
  name: "markup",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]utils[\\/]htmlGenerators\.ts$/ },
      async (args) => {
        const source = await readFile(args.path, "utf8");
        return { contents: tightenMarkup(source, args.path), loader: "ts" };
      },
    );
  },
};

// The page loads mapApp.bundle.js as a module. Replay and Wrapped are a
// quarter of the frontend and most visits open neither, so features.ts
// (replay) and wrapped.ts (Wrapped and the statistics panel) are entry
// points of their own that the app imports the first time each is used
// (services/featureLoader.ts), and so are search.ts (the search of airports
// and places), phone.ts (the phone's bar and sheet), extras.ts (share
// tokens, the export and the popup's list of flights) and local.ts (Your
// flights). With
// splitting, what the entry points have in common is moved into a chunk that
// each of them imports, so there is a single instance of every module that
// holds state (the DOM cache, the toast live region).
//
// esbuild makes one chunk for every set of entry points that reach a module,
// so the entry points could share code in a chunk for every combination of
// two or more of them. Every lazy
// entry point imports mapApp.ts for that reason: everything the app reaches
// is then reached by all of them, and the one chunk that holds it (the app
// itself; mapApp.bundle.js only starts it) can carry a fixed name instead of
// a hash. What is left of each lazy bundle is its own code. A module that
// two lazy bundles use and the app does not would still get a chunk of its
// own; assertExpectedOutputs() fails the build when that happens (move it
// where the app reaches it, as with segmentBounds in utils/geometry.ts, or
// inline it in each lazy module that uses it).
/** @type {import("esbuild").BuildOptions} */
const buildOptions = {
  entryPoints: [
    join(FRONTEND_DIR, "mapApp.ts"),
    join(FRONTEND_DIR, "features.ts"),
    join(FRONTEND_DIR, "wrapped.ts"),
    join(FRONTEND_DIR, "search.ts"),
    join(FRONTEND_DIR, "phone.ts"),
    join(FRONTEND_DIR, "extras.ts"),
    join(FRONTEND_DIR, "local.ts"),
  ],
  outdir: STATIC_DIR,
  entryNames: "[name].bundle",
  chunkNames: "shared.bundle",
  bundle: true,
  format: "esm",
  splitting: true,
  // Always emit a .map file next to the bundle (linked via sourceMappingURL).
  // It carries the mappings and file names only: the TypeScript sources
  // stay out of the site, the container and the wheel alike.
  sourcemap: "linked",
  sourcesContent: false,
  target: ["es2022"],
  platform: "browser",
  logLevel: "info",
  minify,
  metafile: true,
  banner: { js: buildBanner },
  // The build the bundles belong to. The app fetches the lazy bundles and
  // their stylesheets with it as a query (versioned in
  // services/lazyImport.ts), so a page of a new build never runs a lazy
  // bundle of an old one from the browser's cache. It does not keep a page
  // open over a deploy from getting the new files: the host ignores the
  // query. So each lazy bundle exports it as BUILD, and the app does not
  // use one of another build (services/featureLoader.ts).
  define: { __BUILD__: JSON.stringify(sourceHash) },

  // Tree shaking
  treeShaking: true,

  // Don't drop console statements - they are guarded by debug flags in code
  drop: isDevelopment ? [] : ["debugger"],
  plugins: [
    maplibreVendorPlugin,
    yearWorkerPlugin,
    ...(minify ? [shaderPlugin, markupPlugin, lucidePathsPlugin] : []),
  ],
};

// The year worker (services/yearWorker.ts). A build of its own rather than a
// third entry point: a worker shares no module instance with the page, so a
// chunk in common would only be one more file to fetch before it can start,
// and splitting would name that chunk shared.bundle.js as well.
/** @type {import("esbuild").BuildOptions} */
const workerBuildOptions = {
  ...buildOptions,
  entryPoints: [join(FRONTEND_DIR, "services/yearWorker.ts")],
  splitting: false,
  plugins: [pureConstantsPlugin],
};

// The worker that builds the flights a visitor drops on the page
// (services/localWorker.ts), a build of its own for the same reasons. It
// imports Pyodide from its CDN at run time, which stays an import for the
// browser to resolve.
/** @type {import("esbuild").BuildOptions} */
const localWorkerBuildOptions = {
  ...workerBuildOptions,
  entryPoints: [join(FRONTEND_DIR, "services/localWorker.ts")],
  external: ["https://*"],
};

/**
 * Analyze the composition of one output file from the metafile: its bytes
 * by kind of module, and the modules that take the most of it
 * @param {import("esbuild").Metafile} metafile
 * @param {string} fileName
 */
function analyzeBundleComposition(metafile, fileName) {
  console.log(`\n📊 ${fileName} Composition:`);

  const outputs = outputNamed(metafile, fileName);
  if (!outputs || !outputs.inputs) {
    console.log("  No composition data available");
    return;
  }

  // Group imports by type
  /** @type {Record<string, number>} */
  const composition = {};
  const totalBytes = outputs.bytes;

  for (const [file, data] of Object.entries(outputs.inputs)) {
    const bytes = data.bytesInOutput || 0;

    // Categorize files
    let category;
    if (file.includes("frontend/calculations")) {
      category = "🧮 calculations";
    } else if (file.includes("frontend/features")) {
      category = "✨ features";
    } else if (file.includes("frontend/ui")) {
      category = "🎨 ui";
    } else if (file.includes("frontend/utils")) {
      category = "🔧 utils";
    } else if (file.includes("frontend/services")) {
      category = "⚙️  services";
    } else if (file.includes("frontend/state")) {
      category = "💾 state";
    } else {
      category = "📄 other";
    }

    composition[category] = (composition[category] || 0) + bytes;
  }

  // Sort by size descending
  const sorted = Object.entries(composition)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10); // Top 10

  console.log("  Top contributors:");
  for (const [category, bytes] of sorted) {
    const percentage = ((bytes / totalBytes) * 100).toFixed(1);
    console.log(
      `    ${category.padEnd(25)} ${formatBytes(bytes).padStart(10)}  (${percentage}%)`,
    );
  }
  console.log("  Largest modules:");
  for (const [input, bytes] of largestInputs(outputs)) {
    console.log(
      `    ${formatBytes(bytes).padStart(10)}  ${input.replace(/^flown\/frontend\//, "")}`,
    );
  }
}

/**
 * Print what changed in each bundle since the build of an earlier metafile
 * (`--compare`): the bundle's bytes, and those of each module that grew,
 * shrank, came or went, the largest change first
 * @param {import("esbuild").Metafile} before
 * @param {import("esbuild").Metafile} after
 * @param {string[]} names
 */
function compareBundles(before, after, names) {
  /** @param {number} bytes */
  const signed = (bytes) => (bytes > 0 ? "+" : "") + formatBytes(bytes);
  console.log("\n🔀 Changes since the metafile compared with:");
  for (const name of names) {
    const { total, inputs } = inputDeltas(before, after, name);
    console.log(`  ${name}: ${signed(total)}`);
    for (const [input, delta] of inputs.slice(0, 15)) {
      console.log(
        `    ${signed(delta).padStart(11)}  ${input.replace(/^flown\/frontend\//, "")}`,
      );
    }
    if (inputs.length > 15) {
      console.log(`    and ${inputs.length - 15} more`);
    }
  }
}

// Size budgets in bytes, each for the minified files as written (raw) and
// for the same files gzipped at level 9 (gzip, see measure()), which is
// closer to what a visit downloads. Every production build checks them and
// prints each size next to its budget, so every CI job that builds the
// bundles enforces them. Raise one on purpose, in the change that needs the
// room, and say what it paid for in the commit message.
//
// The policy: an app bundle gets about 2 KB of raw and 1 KB of gzipped room
// over its size when the budget is set, a vendored file about 1 %. The
// gzipped budget catches what the raw one rewards the wrong way: a change
// that saves raw bytes by making the code harder to compress. Two pull
// requests that each fit can still not fit together, since each is built
// against the main branch of its day; the budget is checked again on main.
//
// The gzipped sizes depend on the zlib that Node.js was built with, and a
// local build's can differ from CI's by up to about 0.5 %, more for the
// big files. CI is what enforces the budgets, so size a raise by the sizes
// CI prints (the "Build the JavaScript bundle" step of any job), or by a
// build in the Node.js image of the Dockerfile, not by a local build.
//
// The comment of each budget says what it covers and how large that was
// when the budget was last set, nothing more: what a raise or a lowering
// paid for goes in its commit message, and is in the history of its line:
// `git log -L '/^const BUDGET_APP/,+1:build.js'`, or the same for any other
// budget.
//
// The stylesheet has a budget of its own, in tests/test_asset_budget.py: it is
// minified by the Python side, not here.

// What a first visit downloads: the app and the chunk it shares with the
// lazy bundles, which the page loads together (mapApp.bundle.js only starts
// the chunk, so the sum is what counts). What the map draws cannot move to a
// lazy bundle, since a link may open turned, as a globe or in 3D; what only
// a panel or a mode shows can. The reading of a shared link's token stays
// here too: it is resolved before anything reads the state. 169.01 KB and
// 59.7 KB gzipped.
const BUDGET_APP = { raw: 169.25 * 1024, gzip: 60 * 1024 };
// The feature bundle: replay and Replay all, the 3D view (relief, ribbons,
// heat cloud), the imagery, the flight profile, the cross-section, the
// hotspot tour and the intro of a link to shared flights. Fetched only when
// one of them is first used (or ahead of a press that needs it), so no part
// of a first visit. 158.4 KB and 60.57 KB gzipped.
const BUDGET_FEATURES = { raw: 158.5 * 1024, gzip: 60.75 * 1024 };
// The Wrapped bundle: the Wrapped dialog with its intro, and the statistics
// rail, fetched the first time either opens. It shares nothing with the
// feature bundle that the app does not have as well. 43.98 KB and 15.21 KB
// gzipped.
const BUDGET_WRAPPED = { raw: 44 * 1024, gzip: 15.25 * 1024 };
// The search bundle: the panel of the search of airports and places, the
// matching of the site's airports and the client of Photon, fetched the
// first time the search opens. 13.39 KB and 5.35 KB gzipped.
const BUDGET_SEARCH = { raw: 14 * 1024, gzip: 5.75 * 1024 };
// The extras bundle: the packing of the tokens of shared links, the
// export of the map as an image and the airport popup's list of flights,
// fetched by every page once it has a moment. 7.52 KB and 3.67 KB gzipped.
const BUDGET_EXTRAS = { raw: 8 * 1024, gzip: 4 * 1024 };
// The phone bundle: the phone's bar and its sheets, fetched as a phone's
// page starts and as a window turns into the phone layout, and by no other
// page. 14.36 KB and 4.67 KB gzipped.
const BUDGET_PHONE = { raw: 14.5 * 1024, gzip: 4.75 * 1024 };
// Your flights: the panel that takes the KML files a visitor drops, the
// store in the browser and the page's side of the build worker, fetched
// the first time the panel opens or a file is dragged over the page, and at
// start by a page that shows those flights. 25.24 KB and 9.05 KB gzipped.
const BUDGET_LOCAL = { raw: 25.25 * 1024, gzip: 9.25 * 1024 };
// The worker of Your flights, which runs the site's Python in Pyodide and
// fetches and decodes the elevation tiles for it (services/localTiles.ts);
// the runtime itself comes from its CDN and is no part of this. 10.13 KB
// and 4.78 KB gzipped.
const BUDGET_LOCAL_WORKER = { raw: 10.25 * 1024, gzip: 5 * 1024 };
// The year worker (services/yearWorker.ts): fetched by every visit, preloaded
// in the page head beside the app and started with the first year file. It
// decodes the year files and draws the heat sources off the main thread,
// and the lines along the flights: the heat lines and the colour layers'
// lines, with the smoothing of the curves they run along
// (services/flightLines.ts) and the curves it keeps of the flights shown.
// 15.53 KB and 6.83 KB gzipped.
const BUDGET_WORKER = { raw: 16 * 1024, gzip: 7 * 1024 };

// The vendored files are copied as they are but for a few bytes of fixes
// (VENDOR_PATCHES in scripts/vendor.js) and the styles of the controls the
// app never adds (VENDOR_CSS_STRIPS), so a budget cannot make them smaller:
// it is there so a Dependabot bump that makes them noticeably larger fails
// the build and gets looked at. Raise it in the pull request of the bump.
// MapLibre, which every visit loads before the map can draw, leaves a minor
// release about 1 % of room each way: maplibre-gl 6.15.0 comes to
// 1,627,089 B raw and 443,394 B gzipped with the fixes and the strip.
const BUDGET_MAPLIBRE = { raw: 1605 * 1024, gzip: 438 * 1024 };
// html-to-image 1.11.13, bundled into one module and loaded on the first
// export only: 13,667 B raw and 5,430 B gzipped.
const BUDGET_HTML_TO_IMAGE = { raw: 14 * 1024, gzip: 5.5 * 1024 };

const APP_BUNDLE = "mapApp.bundle.js";
const FEATURES_BUNDLE = "features.bundle.js";
const WRAPPED_BUNDLE = "wrapped.bundle.js";
const SEARCH_BUNDLE = "search.bundle.js";
const PHONE_BUNDLE = "phone.bundle.js";
const EXTRAS_BUNDLE = "extras.bundle.js";
const LOCAL_BUNDLE = "local.bundle.js";
const SHARED_BUNDLE = "shared.bundle.js";
const WORKER_BUNDLE = "yearWorker.bundle.js";
const LOCAL_WORKER_BUNDLE = "localWorker.bundle.js";

/** @typedef {import("./scripts/build-helpers.js").Overrun} Overrun */

/**
 * Print the size of every bundle next to its budget and the room it leaves,
 * and return the budgets that are exceeded (empty when all fit)
 * @returns {Overrun[]}
 */
function analyzeBundleSizes() {
  console.log("\n📦 Bundle Size Analysis:");
  console.log("─".repeat(60));

  const vendor = (/** @type {string} */ name) => `vendor/${name}`;
  /** @type {[label: string, names: string[], budget: {raw: number, gzip: number}][]} */
  const bundles = [
    ["🗺️  First visit", [APP_BUNDLE, SHARED_BUNDLE], BUDGET_APP],
    ["✨ Features", [FEATURES_BUNDLE], BUDGET_FEATURES],
    ["🎁 Wrapped", [WRAPPED_BUNDLE], BUDGET_WRAPPED],
    ["🔎 Search", [SEARCH_BUNDLE], BUDGET_SEARCH],
    ["📱 Phone", [PHONE_BUNDLE], BUDGET_PHONE],
    ["🧰 Extras", [EXTRAS_BUNDLE], BUDGET_EXTRAS],
    ["📂 Your flights", [LOCAL_BUNDLE], BUDGET_LOCAL],
    ["🧵 Year worker", [WORKER_BUNDLE], BUDGET_WORKER],
    ["🐍 Build worker", [LOCAL_WORKER_BUNDLE], BUDGET_LOCAL_WORKER],
    [
      "🧭 MapLibre",
      Object.keys(VENDOR_FILES)
        .filter((name) => name.startsWith("maplibre-gl"))
        .map(vendor),
      BUDGET_MAPLIBRE,
    ],
    [
      "🖼️  html-to-image",
      Object.keys(VENDOR_MODULES).map(vendor),
      BUDGET_HTML_TO_IMAGE,
    ],
  ];

  /** @type {Overrun[]} */
  const overruns = [];
  for (const [label, names, budget] of bundles) {
    const described = names.join(" + ");
    try {
      // Every file is its own download, so each is gzipped on its own
      const size = { raw: 0, gzip: 0 };
      for (const name of names) {
        const file = measure(join(STATIC_DIR, name));
        size.raw += file.raw;
        size.gzip += file.gzip;
      }
      // The room in bytes, which is what a change has to fit into
      const room = (/** @type {"raw" | "gzip"} */ kind) => {
        const left = budget[kind] - size[kind];
        return left < 0 ? `${-left} B over` : `${left} B left`;
      };
      console.log(
        `  ${label} (${described}):  ${formatBytes(size.raw)} ` +
          `(budget ${formatBytes(budget.raw)}, ${room("raw")}), ` +
          `${formatBytes(size.gzip)} gzipped ` +
          `(budget ${formatBytes(budget.gzip)}, ${room("gzip")})`,
      );
      for (const kind of /** @type {const} */ (["raw", "gzip"])) {
        if (size[kind] > budget[kind]) {
          overruns.push({
            what: described,
            kind,
            size: size[kind],
            budget: budget[kind],
          });
        }
      }
    } catch (error) {
      console.log(
        `  ❌ Could not measure ${described}:`,
        error instanceof Error ? error.message : error,
      );
      // A bundle that cannot be measured cannot be within budget either
      overruns.push({
        what: described,
        kind: "raw",
        size: NaN,
        budget: budget.raw,
      });
    }
  }

  console.log("─".repeat(60));
  return overruns;
}

async function build() {
  try {
    const mode = isDevelopment ? "development" : "production";
    console.log(`📦 Build mode: ${mode} (minify: ${minify})`);
    console.log(`🔖 ${buildBanner}`);

    const vendored = copyVendorAssets();
    const pinned = Object.entries(vendored.versions)
      .map(([name, version]) => `${name} ${version}`)
      .join(", ");
    console.log(`📥 Vendored ${vendored.count} third-party files: ${pinned}`);

    const flags = copyCountryFlags();
    console.log(
      `🏳️  Copied ${flags.count} country flags (flag-icons ${flags.version})`,
    );

    if (isWatch) {
      console.log("👀 Watching for changes...");
      for (const options of [
        buildOptions,
        workerBuildOptions,
        localWorkerBuildOptions,
      ]) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
      }
    } else {
      console.log("🔨 Building the JavaScript bundles...");
      const [result, workerResult, localWorkerResult] = await Promise.all([
        esbuild.build(buildOptions),
        esbuild.build(workerBuildOptions),
        esbuild.build(localWorkerBuildOptions),
      ]);
      // The site publishes the ten by name (see assertExpectedOutputs)
      assertExpectedOutputs(
        [result.metafile, workerResult.metafile, localWorkerResult.metafile],
        [
          APP_BUNDLE,
          FEATURES_BUNDLE,
          WRAPPED_BUNDLE,
          SEARCH_BUNDLE,
          PHONE_BUNDLE,
          EXTRAS_BUNDLE,
          LOCAL_BUNDLE,
          SHARED_BUNDLE,
          WORKER_BUNDLE,
          LOCAL_WORKER_BUNDLE,
        ],
      );

      console.log("✅ Build complete!");

      // Analyze bundle size and composition
      const overruns = analyzeBundleSizes();

      const composed = [
        SHARED_BUNDLE,
        FEATURES_BUNDLE,
        WRAPPED_BUNDLE,
        SEARCH_BUNDLE,
        PHONE_BUNDLE,
        EXTRAS_BUNDLE,
        LOCAL_BUNDLE,
      ];
      if (result.metafile) {
        for (const name of composed) {
          analyzeBundleComposition(result.metafile, name);
        }
        if (args.compare) {
          compareBundles(
            JSON.parse(readFileSync(args.compare, "utf8")),
            result.metafile,
            [...composed, APP_BUNDLE],
          );
        }
        if (args.metafile) {
          writeFileSync(args.metafile, JSON.stringify(result.metafile));
          console.log(`\n🧾 Wrote the metafile to ${args.metafile}`);
        }
      }

      // A production bundle over budget fails the build wherever it runs;
      // a development bundle is unminified and only gets the warning. On
      // stdout, after everything else, so the reason is the last thing the
      // log shows and is not split from the table by stderr's buffering.
      if (overruns.length > 0) {
        console.log(`\n${overrunSummary(overruns).join("\n")}`);
        if (minify) process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();
