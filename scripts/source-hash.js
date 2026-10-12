/**
 * Content hash of the frontend sources and the build configuration.
 *
 * build.js stamps it into the bundle banner, and the e2e site check reads
 * the banner back to refuse a site that was built from other sources. Both
 * import it from here so the two can never hash differently. The build
 * script, the vendoring script, the compiler options and the versions of
 * esbuild, of the one package bundled into the page (Lucide) and of the
 * packages vendored next to the bundles (MapLibre, html-to-image) shape a
 * built site as much as the sources do, so they are part of the hash.
 *
 * The stylesheets are in it as well. They are not part of any bundle, but
 * they are part of what a built site renders, and the visual snapshots
 * compare exactly that: without them a stylesheet-only change left `docs/`
 * stale and nothing said so.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND_DIR = join(REPO_ROOT, "flown/frontend");
/** Files outside the sources that change what a built site renders */
const BUILD_FILES = [
  "build.js",
  "scripts/build-helpers.js",
  "scripts/vendor.js",
  "tsconfig.json",
  "flown/static/styles.css",
  "flown/static/features.css",
  "flown/static/wrapped.css",
  "flown/static/search.css",
].map((name) => join(REPO_ROOT, name));

/**
 * Packages whose pinned version changes a built site: the bundler, what it
 * bundles from node_modules, and what scripts/vendor.js copies into the site
 * as it is (the map library, the export library and the country flags). The
 * vendored ones are no part of any bundle, but a site that still carries the
 * MapLibre of before a bump is as stale as one with an old bundle, and
 * nothing else would say so. Hashed in this order, after the files.
 */
const BUILD_PACKAGES = [
  "esbuild",
  "lucide",
  "maplibre-gl",
  "html-to-image",
  "flag-icons",
];

/**
 * The version package-lock.json pins for each of BUILD_PACKAGES
 * @returns {string[]}
 */
function buildPackageVersions() {
  const lock = JSON.parse(
    readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"),
  );
  return BUILD_PACKAGES.map(
    (name) =>
      `${name} ${String(lock.packages[`node_modules/${name}`].version)}`,
  );
}

/** First line of every bundle; the capture group is the source hash */
export const BANNER_PATTERN = /^\/\* flown build ([0-9a-f]{12}) \*\//;

/**
 * Recursively list files under a directory
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      // Only the sources: an editor's swap file must not change the hash
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Hash of all frontend sources and the build configuration (deterministic,
 * independent of git)
 * @returns {string}
 */
export function computeSourceHash() {
  const hash = createHash("sha1");
  for (const file of [...listFiles(FRONTEND_DIR), ...BUILD_FILES]) {
    hash.update(relative(REPO_ROOT, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  for (const version of buildPackageVersions()) {
    hash.update(version);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * The banner build.js puts at the top of the bundle
 * @param {string} sourceHash
 * @returns {string}
 */
export function buildBanner(sourceHash) {
  return `/* flown build ${sourceHash} */`;
}

/**
 * The files of the generator that shape a site besides the bundles: the
 * modules of the Python package, its templates and the files right in its
 * static directory, but no bundle or source map (computeSourceHash covers
 * those) and no hidden file. Keep in step with _generator_files in
 * flown/site_assets.py.
 * @returns {string[]}
 */
function generatorFiles() {
  const packageDir = join(REPO_ROOT, "flown");
  /**
   * @param {string} dir
   * @param {string} suffix
   * @returns {string[]}
   */
  const filesIn = (dir, suffix) =>
    readdirSync(join(packageDir, dir), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(suffix) &&
          !entry.name.startsWith(".") &&
          !entry.name.includes(".bundle.js"),
      )
      .map((entry) => join(packageDir, dir, entry.name));
  return [
    ...filesIn(".", ".py"),
    ...filesIn("templates", ""),
    ...filesIn("static", ""),
  ];
}

/**
 * SHA-1 of the path relative to the repository and the content of each
 * file, in path order
 * @param {string[]} files
 * @returns {string}
 */
function hashFiles(files) {
  const named = files.map((file) => ({
    name: relative(REPO_ROOT, file).split(sep).join("/"),
    file,
  }));
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash("sha1");
  for (const { name, file } of named) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Hash of the generator a site was built with, as its map_config.js carries
 * it ("generator", see generator_hash in flown/site_assets.py). The
 * e2e site check compares the two: the build dates its files to the day, or
 * earlier, so their times cannot tell whether the generator changed since.
 * @returns {string}
 */
export function computeGeneratorHash() {
  return hashFiles(generatorFiles()).slice(0, 12);
}

/**
 * Hash of what only the fixture site of scripts/build_visual_site.py is
 * made of: the flights and aircraft of tests/fixtures/visual/ (no hidden
 * file), the two databases and the script itself. The script leaves it in
 * visual-site/fixture.sha1, computed the same way (fixture_hash, whose
 * fixture_inputs lists the same files), and the e2e site check compares
 * the two; the modification times it compared before are of a day of 2025,
 * which SOURCE_DATE_EPOCH gives the fixture site.
 * @returns {string}
 */
export function computeFixtureHash() {
  const fixtureDir = join(REPO_ROOT, "tests", "fixtures", "visual");
  return hashFiles([
    ...readdirSync(fixtureDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map((entry) => join(fixtureDir, entry.name)),
    join(REPO_ROOT, "tests", "fixtures", "airports.csv"),
    join(REPO_ROOT, "tests", "fixtures", "runways.csv"),
    join(REPO_ROOT, "scripts", "build_visual_site.py"),
  ]);
}
