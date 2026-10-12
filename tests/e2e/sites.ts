/**
 * The generated sites the specs run against. Playwright builds neither, so
 * each one names the commands that do; playwright.config.ts serves them and
 * site-check.ts refuses a stale one.
 */
export interface Site {
  /** The directory the web server serves, relative to the repository */
  readonly dir: string;
  readonly port: number;
  /** The commands that build it, for the message about a stale site */
  readonly rebuild: string;
}

/**
 * The port the functional site is served on; the fixture site takes the next
 * one. A second checkout (a git worktree, another branch being tested at the
 * same time) cannot share the default with the first: with
 * `reuseExistingServer` it would quietly test the other checkout's site.
 * E2E_PORT gives each its own. Nothing else would notice: the stale-site
 * check reads the site on disk, not what the server on the port answers. An
 * empty value counts as unset, since wrappers tend to pass the variable on
 * whether or not it is set.
 */
const port = Number(process.env["E2E_PORT"] || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65534) {
  throw new Error(
    `E2E_PORT must be a port number, not "${process.env["E2E_PORT"]}"`,
  );
}

export const SITES = {
  /** Every flight in data/, what the functional specs drive */
  docs: {
    dir: "docs",
    port,
    rebuild: "npm run build && python -m flown data --output-dir docs",
  },
  /**
   * The fixture flights of tests/fixtures/visual/ with a fixed build stamp.
   * The snapshots are compared pixel for pixel, and every new flight in
   * data/ moved the figures in them.
   */
  visual: {
    dir: "visual-site",
    port: port + 1,
    rebuild: "npm run build && python scripts/build_visual_site.py",
  },
} as const satisfies Record<string, Site>;

export type SiteName = keyof typeof SITES;

/** The project option naming the site its specs drive (fixtures.ts) */
export interface SiteOptions {
  site: SiteName;
}
