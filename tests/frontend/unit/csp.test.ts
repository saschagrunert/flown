import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The page's Content Security Policy against the URLs the frontend fetches.
 *
 * The policy is a meta tag in the page template and the URLs are constants
 * in the modules that add the map's sources, so nothing ties one to the
 * other: a new tile host, or a policy narrowed past a host still in use,
 * only shows as blank tiles and a CSP violation in the browser console. The
 * e2e fixture answers the tile servers itself, and the browser checks the
 * policy before the request is routed, so the specs that draw a layer catch
 * a missing host; this catches it without a browser, and for every layer.
 */

const REPO_ROOT = resolve(__dirname, "../../..");
const FRONTEND_DIR = join(REPO_ROOT, "flown/frontend");

/**
 * URLs in the frontend that the page never fetches: link targets and the
 * sources named in the attributions. Anything else starting with https://
 * is taken as fetched and has to be allowed by connect-src.
 */
const LINKS = [
  "https://www.google.com/maps?",
  "https://www.openflightmaps.org",
  "https://cloudless.eox.at",
  "https://registry.opendata.aws/terrain-tiles/",
  "https://github.com/saschagrunert/flown",
  // The credit of the search of places; the link to Photon's own page is
  // taken as fetched, which its API's place in connect-src allows
  "https://www.openstreetmap.org/copyright",
  // Fetched by the worker that builds the flights a visitor drops
  // (services/localWorker.ts), not by the page: a worker started from a
  // file of the site gets the policy of that file's response, which the
  // page's meta tag is no part of, so the page's connect-src does not
  // reach it
  "https://cdn.jsdelivr.net/pyodide/",
];

/**
 * What the CARTO style points to, which MapLibre then fetches: its tile
 * description, the vector tiles on the hosts that description lists, the
 * glyphs and the sprite. None of them is in the sources.
 */
const CARTO_STYLE_URLS = [
  "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json",
  "https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/1/2/3.mvt",
  "https://tiles-d.basemaps.cartocdn.com/vectortiles/carto.streets/v1/1/2/3.mvt",
  "https://tiles.basemaps.cartocdn.com/fonts/Montserrat%20Medium/0-255.pbf",
  "https://tiles.basemaps.cartocdn.com/gl/dark-matter-gl-style/sprite.png",
];

function readPolicy(): Map<string, string[]> {
  const template = readFileSync(
    join(REPO_ROOT, "flown/templates/map_template.html"),
    "utf8",
  );
  const content =
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(
      template,
    )?.[1];
  if (!content) throw new Error("map_template.html declares no CSP");
  const directives = new Map<string, string[]>();
  for (const directive of content.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

/**
 * Whether a host source expression of CSP Level 3 matches a URL: the scheme,
 * the host (a leading `*.` matches subdomains only, not the host itself) and,
 * when the source has a path, the path, as a prefix when the source's path
 * ends in a slash and in full otherwise. The query is never part of it. Only
 * the forms the template uses; no ports.
 */
function sourceMatches(source: string, url: string): boolean {
  const match = /^(https?):\/\/(\*\.)?([^/:]+)(\/.*)?$/.exec(source);
  if (!match) return false;
  const [, scheme, wildcard, host, path] = match;
  const target = new URL(url);
  if (target.protocol !== `${scheme}:`) return false;
  const targetHost = target.hostname.toLowerCase();
  const sourceHost = host!.toLowerCase();
  const hostMatches = wildcard
    ? targetHost.endsWith(`.${sourceHost}`)
    : targetHost === sourceHost;
  if (!hostMatches) return false;
  if (!path) return true;
  return path.endsWith("/")
    ? target.pathname.startsWith(path)
    : target.pathname === path;
}

function allowedBy(sources: string[], url: string): boolean {
  return sources.some((source) => sourceMatches(source, url));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every https:// URL written in a string or template literal of the
 * frontend, with the tile placeholders and interpolations filled in, by the
 * file it is in
 */
function frontendUrls(): { file: string; url: string }[] {
  return sourceFiles(FRONTEND_DIR).flatMap((path) => {
    const file = relative(REPO_ROOT, path);
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/["'`](https:\/\/[^"'`\s]+)/g)].map((match) => ({
      file,
      url: match[1]!.replace(/\{[a-z]+\}/g, "1").replace(/\$\{[^}]*\}/g, "1"),
    }));
  });
}

function isLink(url: string): boolean {
  return LINKS.some((link) => url.startsWith(link));
}

describe("the Content Security Policy", () => {
  const connectSrc = readPolicy().get("connect-src") ?? [];
  const fetched = frontendUrls().filter(({ url }) => !isLink(url));

  it("finds the URLs of the map's sources in the frontend", () => {
    // Guards the scan itself: every tile and style host the page uses, and
    // the geocoder of the search
    const hosts = new Set(fetched.map(({ url }) => new URL(url).hostname));
    expect([...hosts].sort()).toEqual([
      "basemaps.cartocdn.com",
      "nwy-tiles-api.prod.newaydata.com",
      "photon.komoot.io",
      "s3.amazonaws.com",
      "tiles.maps.eox.at",
    ]);
  });

  it("allows every URL the frontend fetches in connect-src", () => {
    const blocked = fetched.filter(({ url }) => !allowedBy(connectSrc, url));
    expect(blocked).toEqual([]);
  });

  it("allows what the CARTO style points to", () => {
    const blocked = CARTO_STYLE_URLS.filter(
      (url) => !allowedBy(connectSrc, url),
    );
    expect(blocked).toEqual([]);
  });

  it("names no foreign source that nothing fetches", () => {
    const used = [...fetched.map(({ url }) => url), ...CARTO_STYLE_URLS];
    const unused = connectSrc
      .filter((source) => source !== "'self'" && source !== "blob:")
      .filter((source) => !used.some((url) => sourceMatches(source, url)));
    expect(unused).toEqual([]);
  });

  it("allows the Blob URLs of the heat sources, and no other scheme", () => {
    // MapLibre's worker reads the heat sources from Blob URLs of what the
    // year worker wrote (services/heatSource.ts), which a browser may hold
    // it to the page's policy for
    const heatSource = readFileSync(
      join(FRONTEND_DIR, "ui/dataManager.ts"),
      "utf8",
    );
    expect(heatSource).toContain("URL.createObjectURL(");
    expect(connectSrc.filter((source) => /^[a-z-]+:$/.test(source))).toEqual([
      "blob:",
    ]);
  });

  it("allows only the elevation bucket on S3, not every bucket", () => {
    expect(
      allowedBy(
        connectSrc,
        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/8/134/86.png",
      ),
    ).toBe(true);
    expect(
      allowedBy(connectSrc, "https://s3.amazonaws.com/another-bucket/a.png"),
    ).toBe(false);
    expect(
      allowedBy(
        connectSrc,
        "https://s3.amazonaws.com/elevation-tiles-prod-copy/a.png",
      ),
    ).toBe(false);
  });
});

describe("sourceMatches", () => {
  it("matches a host source on any path", () => {
    expect(
      sourceMatches("https://tiles.maps.eox.at", "https://tiles.maps.eox.at/a"),
    ).toBe(true);
    expect(
      sourceMatches("https://tiles.maps.eox.at", "http://tiles.maps.eox.at/a"),
    ).toBe(false);
  });

  it("matches a wildcard on subdomains only", () => {
    const source = "https://*.basemaps.cartocdn.com";
    expect(sourceMatches(source, "https://tiles.basemaps.cartocdn.com/")).toBe(
      true,
    );
    expect(sourceMatches(source, "https://basemaps.cartocdn.com/")).toBe(false);
    expect(sourceMatches(source, "https://evilbasemaps.cartocdn.com/")).toBe(
      false,
    );
  });

  it("matches a path ending in a slash as a prefix, another one in full", () => {
    expect(
      sourceMatches("https://example.com/a/", "https://example.com/a/b?c=d"),
    ).toBe(true);
    expect(
      sourceMatches("https://example.com/a", "https://example.com/a?c=d"),
    ).toBe(true);
    expect(
      sourceMatches("https://example.com/a", "https://example.com/a/b"),
    ).toBe(false);
  });
});
