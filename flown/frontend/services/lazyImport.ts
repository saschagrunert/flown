import { withTimeout } from "../utils/withTimeout";

/**
 * What to do about code that could not be fetched, after the sentence that
 * says so: the next press asks the server again (see importWithRetry),
 * under another URL
 */
export const TRY_AGAIN = ". Check the connection and try again.";

/**
 * The import of a file the app fetches on first use, and of the same file
 * again after a failure.
 *
 * A browser may remember a failed import for as long as the page is open
 * and answer every later import() of that URL with the same failure,
 * without asking the server again. A retry therefore names the file under a
 * URL the page has not tried yet. The first attempt is the caller's own: the
 * build resolves its literal specifier (to a lazy bundle, which shares its
 * modules with the app through shared.bundle.js, or to a vendored module)
 * and leaves the computed one of a retry alone. Every bundle sits next to
 * this one, so `file` resolves the same from whichever holds this module.
 * A file named with a query (see `versioned`) is imported by that name on
 * the first attempt as well.
 * @param first - The first attempt, an import() with a literal specifier
 * @param file - What the build names the file, relative to the bundles
 * @param failedImports - Imports that were rejected before this one
 */
export function importWithRetry<T>(
  first: () => Promise<T>,
  file: string,
  failedImports: number,
): Promise<T> {
  const query = file.includes("?");
  return failedImports === 0 && !query
    ? first()
    : (import(
        new URL(
          failedImports
            ? `${file}${query ? "&" : "?"}retry=${failedImports}`
            : file,
          import.meta.url,
        ).href
      ) as Promise<T>);
}

/**
 * Imports by `load`, each given up on after `timeoutMs` with `message`: an
 * import cannot be aborted. One that was rejected counts as failed, so the
 * next names the file anew (see importWithRetry); one that merely timed out
 * does not, since it may still finish, and the same URL then gets the
 * module.
 */
export function timedImports<T>(
  load: (failedImports: number) => Promise<T>,
  timeoutMs: number,
  message: string,
): () => Promise<T> {
  let failedImports = 0;
  return () => {
    const attempt = load(failedImports);
    attempt.catch(() => failedImports++);
    return withTimeout(attempt, timeoutMs, message);
  };
}

/**
 * `url` with the build it belongs to (the source hash build.js stamps into
 * the bundles), for the files the app fetches long after the page. The
 * query keeps a page of a new build from running a lazy bundle or its
 * stylesheet of an old one out of the browser's cache, since the cache
 * holds them under another URL. It does not keep an old page from getting
 * the new files after a deploy: the host serves the file it has, whatever
 * the query. Versioning shared.bundle.js as well would give the page a
 * second copy of the app's modules, each with its own state, so the app
 * compares the build a lazy bundle exports with its own instead (see
 * services/featureLoader.ts). As it is when there is no build, in tests
 * and in the sources.
 */
export function versioned(url: string): string {
  return typeof __BUILD__ === "string" ? `${url}?v=${__BUILD__}` : url;
}
