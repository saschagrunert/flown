/**
 * The third-party files the published page loads.
 *
 * They used to come from unpkg and jsdelivr with subresource integrity
 * hashes. Serving them from the site instead means the map still works
 * during a CDN outage, no visitor's IP reaches a third party, and the
 * page's CSP needs no foreign origin. The
 * copies are taken straight from node_modules, so package-lock.json stays
 * the single place their versions are pinned and Dependabot can bump them
 * like any other dependency. The one thing left off a copy is the closing
 * comment that names a source map the site does not carry, and the one
 * thing changed in one is a few fixes of bugs of MapLibre or of a browser
 * under it, and of work it does on the main thread that the app cannot
 * spare it otherwise (VENDOR_PATCHES). MapLibre's stylesheet is copied
 * without the styles of the controls the app never adds
 * (VENDOR_CSS_STRIPS), three quarters of it.
 * html-to-image is the exception to "as it is": the package has no module
 * in one file, so its module is bundled into one here (VENDOR_MODULES).
 *
 * build.js copies them into flown/static/vendor/ (generated, not
 * committed) and the Python side publishes that directory next to the page.
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join, posix } from "node:path";
import { buildSync } from "esbuild";
import { REPO_ROOT } from "./source-hash.js";

const NODE_MODULES = join(REPO_ROOT, "node_modules");
const VENDOR_DIR = join(REPO_ROOT, "flown/static/vendor");

/**
 * Country flags, kept apart from the vendored files above because the page
 * never loads all of them: the Python side publishes only the countries an
 * export actually visited, and the rest never leave the checkout.
 */
const FLAG_DIR = join(REPO_ROOT, "flown/static/flags");
const FLAG_SOURCE = join(NODE_MODULES, "flag-icons/flags/4x3");

/**
 * Published path inside vendor/ -> path inside node_modules.
 *
 * MapLibre is two modules that have to sit next to each other under these
 * names: maplibre-gl.mjs starts its worker from `./maplibre-gl-worker.mjs`
 * relative to its own URL. Since 6.13.0 the worker carries its own copy of
 * the code the two share, rather than importing it from a third module.
 * That worker is a module of the site's own origin, which is why the page's
 * CSP gets by with `worker-src 'self'` and no `blob:`. The app bundle imports
 * maplibre-gl.mjs from here instead of carrying a copy (see build.js).
 * flown/site_assets.py keeps the list of the files it publishes in
 * step with this one; tests/frontend/unit/vendor.test.ts checks this list
 * against node_modules.
 * @type {Record<string, string>}
 */
export const VENDOR_FILES = {
  "maplibre-gl.mjs": "maplibre-gl/dist/maplibre-gl.mjs",
  "maplibre-gl-worker.mjs": "maplibre-gl/dist/maplibre-gl-worker.mjs",
  "maplibre-gl.css": "maplibre-gl/dist/maplibre-gl.css",
};

/**
 * Published path inside vendor/ -> package whose module entry point is
 * bundled into that one file.
 *
 * The app loads html-to-image with import(), on the first export (see
 * build.js and ui/mapExport.ts). The package ships its ES module as a dozen
 * files and its single file as UMD, which import() cannot take exports from,
 * so the module is bundled here: nothing but the package's own code, under
 * a banner that names it, its version and its licence.
 * @type {Record<string, string>}
 */
export const VENDOR_MODULES = {
  "html-to-image.mjs": "html-to-image",
};

/**
 * The version package-lock.json pins for a vendored package
 * @param {string} name
 * @returns {string}
 */
function pinnedVersion(name) {
  const lock = JSON.parse(
    readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
  );
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry) throw new Error(`package-lock.json does not pin ${name}`);
  return String(entry.version);
}

/**
 * The `//# sourceMappingURL=` line or block comment that closes a file, with
 * the name it points at. It has to stand on a line of its own and be the
 * last thing in the file, so the same words inside a string literal, or
 * inside another comment, are never taken for it. The name ends at plain
 * white space and not at `\s`: the bytes are read as latin1, where the second
 * byte of many UTF-8 characters is the no-break space that `\s` matches.
 */
const SOURCE_MAP_COMMENT =
  /(?:^|\n)[ \t]*(?:\/\/[#@] ?sourceMappingURL=([^ \t\r\n]+)|\/\*[#@] ?sourceMappingURL=([^ \t\r\n]+?) ?\*\/)[ \t\r\n]*$/;

/**
 * A vendored file without the closing comment that names its source map.
 *
 * The packages ship their maps next to the files, and MapLibre's come to
 * five megabytes, so they are not vendored. Left in, the comment makes every
 * DevTools session on the published site ask for a map and get a 404. A
 * comment whose map is vendored is kept: the name is resolved against the
 * directory the file is published in, as a browser would. Every other byte
 * stays: the content is matched as latin1, one character per byte, so
 * nothing is decoded and written back differently and a binary file passes
 * through.
 * @param {Buffer} content
 * @param {string} [published] - Path of the file inside vendor/
 * @returns {Buffer}
 */
export function stripSourceMapComment(content, published = "") {
  const match = SOURCE_MAP_COMMENT.exec(content.toString("latin1"));
  if (!match) return content;
  const map = posix.normalize(
    posix.join(posix.dirname(published), match[1] ?? match[2] ?? ""),
  );
  // Not `in`: that also finds what every object inherits ("constructor")
  if (Object.hasOwn(VENDOR_FILES, map)) return content;
  // The line break before the comment belongs to the code above it
  const start = match[0].startsWith("\n") ? match.index + 1 : match.index;
  return content.subarray(0, start);
}

/**
 * Whether the page runs in WebKit on Linux: WebKitGTK (Epiphany) or WPE
 * (Playwright's WebKit), as a JavaScript expression for the main thread of
 * the page, which a fix of VENDOR_PATCHES inserts. The platform, not the
 * user agent, tells Linux: Playwright's WebKit says "Macintosh" in its user
 * agent, and "Linux x86_64" in navigator.platform, as WebKitGTK does. The
 * engine is WebKit when the user agent names AppleWebKit and no Chrome:
 * Chrome, Chromium, Edge and Opera on Linux name AppleWebKit and Chrome,
 * Chrome on Android both and Android. Safari says MacIntel, iPhone or iPad,
 * and Firefox names no AppleWebKit.
 */
export const LINUX_WEBKIT =
  'typeof navigator<"u"&&/^Linux/.test(navigator.platform)' +
  "&&/AppleWebKit/.test(navigator.userAgent)" +
  "&&!/Chrom|Android/.test(navigator.userAgent)";

/**
 * @typedef {object} VendorPatch
 * @property {string} name - What it fixes, for the error when it no longer
 *   applies
 * @property {RegExp} find - The code it replaces, which has to occur exactly
 *   once in the file; its groups keep the minifier's names
 * @property {string} replace - The code in its place (`$1` and on for the
 *   groups)
 */

/**
 * Published path inside vendor/ -> the fixes made to that file as it is
 * copied, each to the minified code of the version package-lock.json pins.
 *
 * Kept to bugs of MapLibre, or of a browser that MapLibre meets, that the
 * app cannot work around from the outside (a cost MapLibre puts on the main
 * thread among them), each a few characters, with its upstream issue text
 * in the owner's hands, and to the worker's URL, which has to be the one the
 * page preloads.
 * A fix whose code is no longer found exactly once fails the build: after a
 * bump, see whether the new version fixed the bug (drop the patch) or only
 * renamed the code around it (match it again). A patch in place of a copy
 * of the source keeps the version pinned in one place, and the file small.
 * @type {Record<string, VendorPatch[]>}
 */
export const VENDOR_PATCHES = {
  "maplibre-gl.mjs": [
    {
      // MercatorCoveringTilesDetailsProvider.getTileBoundingVolume: with the
      // relief, a tile's box spans the relief's lowest to highest point, and
      // leaves out the height of the point the camera looks at, which the
      // globe's provider keeps (Math.max). The chase view looks at the
      // airplane in the air: the tiles of its trail under the camera fell
      // outside the view and were never loaded, and no trail was drawn near
      // the airplane.
      name: "tiles culled below the camera's centre on the relief",
      find: /(getTileBoundingVolume\(\w+,\w+,(\w+),(\w+)\)\{let (\w+)=Math\.min\(0,\2\),(\w+)=Math\.max\(0,\2\);if\(\3\?\.terrain\)\{[^}]*?\5=)(\w+)\.maxElevation\?\?\5\}/,
      replace: "$1Math.max($6.maxElevation??$5,$5)}",
    },
    {
      // Tile.loadVectorData: a GeoJSON tile that loads empty after a
      // `setData` keeps the raw data of what it held before. Leaving the 3D
      // view empties the ribbons' sources, and their tiles held on to
      // 12 MB (a year) to 38 MB (all years) of data nothing drew anymore.
      name: "raw tile data kept by a tile that loads empty",
      find: /(!(\w+)\)\{this\.collisionBoxArray=new \w+)(;return\}\2\.featureIndex&&\(this\.latestFeatureIndex=\2\.featureIndex,\2\.rawTileData\?)/,
      replace: "$1,this.latestRawTileData=null,this.latestEncoding=null$3",
    },
    {
      // RasterDEMTileSource.loadTile: an elevation tile goes to the worker
      // as the ImageBitmap it was fetched as. In WebKit on Linux (WebKitGTK,
      // as in Epiphany, and WPE, the WebKit of Playwright), which draws with
      // Skia, that crashed or hung the page's process: Skia aborted under
      // ImageBitmap::create as the worker took the bitmap in, a page that
      // closed met a null pointer in Skia's GPU resource cache, and the
      // worker never answered for some tiles. The relief's e2e tests in
      // Playwright's WebKit (build webkit-2359) lost 8 processes and hung 4
      // times in 95 tests, and passed 40 of 40 with this. There the tile is
      // read into plain pixels on the main thread first (readImageNow), as
      // MapLibre does where OffscreenCanvas is missing; every other browser
      // keeps sending the bitmap (see LINUX_WEBKIT). Not reported upstream
      // yet: the text is with the owner.
      name: "elevation tiles taken apart in the worker by Linux WebKit",
      find: /(\w+)=(\w+)\((\w+)\)&&(\w+)\(\)\?\3:await this\.readImageNow\(\3\)/,
      replace: `$1=$2($3)&&$4()&&!(${LINUX_WEBKIT})?$3:await this.readImageNow($3)`,
    },
    {
      // getDefaultWorkerUrl: the worker is started from
      // `./maplibre-gl-worker.mjs?v=<version>`, which MapLibre added (6.13.0)
      // so that a browser cannot pair a new maplibre-gl.mjs with a worker of
      // the version before from its cache. The page preloads the worker by
      // the name it is published under (map_template.html), and a URL with
      // a query is another URL to the browser: the preload went unused and
      // the worker, 140 KB gzipped, was downloaded twice. The site publishes
      // both files together, like its own bundles, whose names carry no
      // version either.
      name: "the worker started by a URL the page does not preload",
      find: /(\w+)\.searchParams\.set\(`v`,\w+\),(\1\.href)/,
      replace: "$2",
    },
  ],
  "maplibre-gl-worker.mjs": [
    {
      // makeRequest: a URL of a scheme other than http(s) or file is fetched
      // by the main thread for a worker (the "GR" message), so that a
      // protocol added with addProtocol there can answer it. A blob: URL
      // has no such protocol, and a worker can fetch it itself. The heat
      // sources, the heat lines and the colour layers' lines of every
      // flight are given one of the GeoJSON the year worker wrote
      // (services/heatSource.ts, services/flightLines.ts) to keep their
      // 135,000 features for all years off the main thread; fetched there,
      // the 16 MB of text would be parsed on it and the objects sent on to
      // the worker after all. The copy in maplibre-gl.mjs is left alone: on
      // the main thread a blob: URL is fetched either way.
      name: "blob: URLs fetched by the main thread for a worker",
      find: /(\w+)\.url\.includes\(`:\/\/`\)&&!\/\^https\?:\|\^file:\/\.test\(\1\.url\)/,
      replace: "$1.url.includes(`://`)&&!/^https?:|^file:|^blob:/.test($1.url)",
    },
    {
      // GeoJSONWorkerSource.loadData: GeoJSON loaded from a URL is sent
      // back to the main thread whole, so that getData() can answer with
      // it, which the app never asks of a source it gives a URL. For all
      // years that is 135,000 features cloned onto the main thread and
      // copied there once more by MapLibre, which is what those sources
      // are given a URL to spare it. Not for a blob: URL, which only the
      // app's sources written by the year worker are given (the heat, the
      // heat lines, the colour layers' lines of every flight): getData() of
      // such a source (and getBounds(), which asks it) waits for its next
      // load and then fails, so the app must call neither on any of them.
      name: "GeoJSON of a blob: URL sent back to the main thread",
      find: /(\w+)\.request&&\((\w+)\.data=\1\.data\)/,
      replace:
        "$1.request&&!$1.request.url.startsWith(`blob:`)&&($2.data=$1.data)",
    },
  ],
};

/**
 * Published path inside vendor/ -> the controls of MapLibre whose styles
 * are left out of that stylesheet as it is copied.
 *
 * MapLibre's stylesheet is 83 KB, three quarters of it the icons of its
 * controls as `data:` URIs: the navigation buttons, the geolocate button
 * in its six states, the fullscreen, globe and terrain buttons, the scale
 * and the logo, each drawn again for forced colours in light and dark.
 * The app adds none of them (its attribution control alone, and its own
 * controls in styles.css), so every rule whose selectors all name one of
 * these is dropped (stripControlStyles). What is left is the map, its
 * canvas, the attribution, the markers and the popups, 11 KB. `rules` is
 * how many rules the pinned version loses: a bump of MapLibre that adds
 * or renames a control fails the build here, so the list gets looked at
 * rather than the icons shipped again unseen.
 * @type {Record<string, {names: string[], rules: number}>}
 */
export const VENDOR_CSS_STRIPS = {
  "maplibre-gl.css": {
    names: [
      // NavigationControl
      "maplibregl-ctrl-zoom-in",
      "maplibregl-ctrl-zoom-out",
      "maplibregl-ctrl-compass",
      // The group the navigation buttons sit in; the attribution is none
      "maplibregl-ctrl-group",
      // FullscreenControl, and the map in full screen
      "maplibregl-ctrl-fullscreen",
      "maplibregl-ctrl-shrink",
      "maplibregl-pseudo-fullscreen",
      "maplibregl-map:fullscreen",
      // GlobeControl and TerrainControl
      "maplibregl-ctrl-globe",
      "maplibregl-ctrl-terrain",
      // GeolocateControl, with the dot it draws and its animations
      "maplibregl-ctrl-geolocate",
      "maplibregl-user-location",
      "maplibregl-spin",
      // LogoControl and ScaleControl
      "maplibregl-ctrl-logo",
      "maplibregl-ctrl-scale",
    ],
    rules: 62,
  },
};

/**
 * The rules of a minified stylesheet, each with its braces, so that
 * joining them gives the text back: the ones between the top-level braces
 * of `css`, at-rules included whole.
 * @param {string} css
 * @returns {string[]}
 */
function cssRules(css) {
  /** @type {string[]} */
  const rules = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) {
      rules.push(css.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (depth !== 0 || start !== css.length) {
    throw new Error("scripts/vendor.js: the stylesheet is not minified rules");
  }
  return rules;
}

/**
 * Whether every selector of a rule, or the name of an at-rule, names one
 * of `names` (see VENDOR_CSS_STRIPS)
 * @param {string} head - What stands before the rule's first brace
 * @param {string[]} names
 * @returns {boolean}
 */
function namesOnly(head, names) {
  const selectors = head.startsWith("@") ? [head] : head.split(",");
  return selectors.every((selector) =>
    names.some((name) => selector.includes(name)),
  );
}

/**
 * The stylesheet `css` without the rules whose selectors all name one of
 * `names`, and without a conditional at-rule (`@media`) left with none;
 * `dropped` counts the rules it loses, nested ones one by one
 * @param {string} css
 * @param {string[]} names
 * @param {{count: number}} dropped
 * @returns {string}
 */
function withoutRules(css, names, dropped) {
  return cssRules(css)
    .map((rule) => {
      const open = rule.indexOf("{");
      const head = rule.slice(0, open);
      if (namesOnly(head, names)) {
        dropped.count++;
        return "";
      }
      // A conditional at-rule holds rules of its own; @keyframes holds
      // steps, which are kept with their name
      if (!/^@(?:media|supports)\b/.test(head)) return rule;
      const kept = withoutRules(rule.slice(open + 1, -1), names, dropped);
      return kept ? `${head}{${kept}}` : "";
    })
    .join("");
}

/**
 * The stylesheet `published` without the styles of the controls the app
 * never adds (VENDOR_CSS_STRIPS); as latin1, like applyVendorPatches, so
 * every other byte stays as it is. The number of rules lost has to be the
 * one recorded there, or the build fails.
 * @param {Buffer} content
 * @param {string} published - Path of the file inside vendor/
 * @returns {Buffer}
 */
export function stripControlStyles(content, published) {
  const strip = VENDOR_CSS_STRIPS[published];
  if (!strip) return content;
  const dropped = { count: 0 };
  const text = withoutRules(content.toString("latin1"), strip.names, dropped);
  if (dropped.count !== strip.rules) {
    throw new Error(
      `scripts/vendor.js: ${dropped.count} rules of ${published} name the ` +
        `controls the app never adds, not ${strip.rules}. Has MapLibre ` +
        `changed its controls? See VENDOR_CSS_STRIPS.`,
    );
  }
  return Buffer.from(text, "latin1");
}

/**
 * A vendored file with its fixes (VENDOR_PATCHES) made and the styles of
 * the controls the app never adds left out (VENDOR_CSS_STRIPS). Matched as
 * latin1, one character per byte, like stripSourceMapComment, so every
 * other byte stays as it is.
 * @param {Buffer} content
 * @param {string} published - Path of the file inside vendor/
 * @returns {Buffer}
 */
export function applyVendorPatches(content, published) {
  const patches = VENDOR_PATCHES[published];
  if (!patches) return stripControlStyles(content, published);
  let text = content.toString("latin1");
  for (const { name, find, replace } of patches) {
    const found = [...text.matchAll(new RegExp(find.source, "g"))].length;
    if (found !== 1) {
      throw new Error(
        `scripts/vendor.js: the fix "${name}" matches ${found} places in ` +
          `${published} instead of one. Has MapLibre changed there? See ` +
          `VENDOR_PATCHES.`,
      );
    }
    text = text.replace(find, replace);
  }
  return Buffer.from(text, "latin1");
}

/**
 * Copy the vendored files into flown/static/vendor/.
 *
 * The directory is replaced rather than written over, so a file dropped
 * from the list above does not linger in a checkout and get published.
 * @returns {{count: number, versions: Record<string, string>}}
 */
export function copyVendorAssets() {
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  for (const [published, source] of Object.entries(VENDOR_FILES)) {
    const destination = join(VENDOR_DIR, published);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      applyVendorPatches(
        stripSourceMapComment(
          readFileSync(join(NODE_MODULES, source)),
          published,
        ),
        published,
      ),
    );
  }
  for (const [published, name] of Object.entries(VENDOR_MODULES)) {
    const manifest = JSON.parse(
      readFileSync(join(NODE_MODULES, name, "package.json"), "utf8"),
    );
    buildSync({
      entryPoints: [join(NODE_MODULES, name, manifest.module)],
      outfile: join(VENDOR_DIR, published),
      bundle: true,
      format: "esm",
      target: ["es2022"],
      platform: "browser",
      minify: true,
      legalComments: "none",
      banner: {
        js: `/* ${name} ${pinnedVersion(name)}, ${manifest.license} licence, ${manifest.homepage} */`,
      },
      logLevel: "warning",
    });
  }
  /** @type {Record<string, string>} */
  const versions = {};
  for (const name of ["maplibre-gl", ...Object.values(VENDOR_MODULES)]) {
    versions[name] = pinnedVersion(name);
  }
  const count =
    Object.keys(VENDOR_FILES).length + Object.keys(VENDOR_MODULES).length;
  return { count, versions };
}

/**
 * Copy the country flags into flown/static/flags/.
 *
 * All of them, because which ones a site needs depends on the flights it is
 * built from; `flown/site_assets.py` publishes the handful an export
 * touched. Like vendor/, the directory is generated, gitignored and left out
 * of the wheel, so a copy installed from PyPI falls back to the country
 * code rather than shipping two megabytes of flags nobody asked for.
 * @returns {{count: number, version: string}}
 */
export function copyCountryFlags() {
  rmSync(FLAG_DIR, { recursive: true, force: true });
  mkdirSync(FLAG_DIR, { recursive: true });
  const flags = readdirSync(FLAG_SOURCE).filter((name) =>
    name.endsWith(".svg"),
  );
  for (const name of flags) {
    copyFileSync(join(FLAG_SOURCE, name), join(FLAG_DIR, name));
  }
  return { count: flags.length, version: pinnedVersion("flag-icons") };
}
