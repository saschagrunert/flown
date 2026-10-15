/**
 * The page's Trusted Types. Its CSP (`require-trusted-types-for 'script'`
 * in the template) lets no string reach a sink that parses HTML or starts a
 * script unless a policy made it, and allows two policies by name.
 *
 * "flown" is the app's: its markup goes into the sinks through
 * `trustedHtml`, and eslint.config.js fails a sink of the frontend that
 * does not. The policy takes the markup as it is, so it is the builders
 * that keep a name of a dropped file or of aircraft.json text: each one
 * escapes what it puts in (utils/escape.ts).
 *
 * "default" is for the code that is not the app's and hands the sinks plain
 * strings. MapLibre starts its worker from a URL, as the app starts the year
 * worker and the build worker (services/yearDecoder.ts and localBuild.ts),
 * so a script URL passes when it is a file of the page's own directory,
 * what script-src and worker-src allow, and nothing else does. MapLibre also
 * writes the close button of a popup (`&#215;`) with innerHTML, and parses
 * every source's credit with DOMParser before it removes what it does not
 * allow from it: of HTML the default policy keeps the links, `</a>` and an
 * `<a ...>` whose attributes can run nothing (quoted values of the names
 * below, an href of the web or of mail), and turns every other `<` into
 * `&lt;`, so a credit keeps its links and any other markup handed to a
 * sink stays text, a link with an event handler included.
 *
 * Without Trusted Types (jsdom, a browser that has none) there is no
 * policy, and the strings go into the sinks as they are.
 */

interface Policy {
  createHTML(input: string): unknown;
}

interface PolicyFactory {
  createPolicy(
    name: string,
    rules: {
      createHTML(input: string): string;
      createScriptURL?(input: string): string | null;
    },
  ): Policy;
}

/** A link that runs nothing, or any other "<" (to escape) */
const LINK_OR_TAG =
  /<\/a\s*>|<a(?:\s+(?:(?:class|dir|lang|rel|target|title)\s*=\s*(?:"[^"<]*"|'[^'<]*')|href\s*=\s*(?:"(?:https?:\/\/|mailto:)[^"<]*"|'(?:https?:\/\/|mailto:)[^'<]*')))*\s*>|</gi;

const factory = (globalThis as { trustedTypes?: PolicyFactory }).trustedTypes;
const policy = factory?.createPolicy("flown", {
  createHTML: (markup) => markup,
});
factory?.createPolicy("default", {
  createHTML: (html) =>
    html.replace(LINK_OR_TAG, (tag) => (tag === "<" ? "&lt;" : tag)),
  // Null refuses it: the sink throws and the browser reports the violation
  createScriptURL: (url) =>
    new URL(url, document.baseURI).href.startsWith(
      new URL(".", document.baseURI).href,
    )
      ? url
      : null,
});

/**
 * Markup of the app for innerHTML, insertAdjacentHTML or a popup's setHTML.
 * Typed as the string it is made from, which is what the DOM's types (and
 * MapLibre's) take; a sink takes the TrustedHTML just as well.
 */
export function trustedHtml(markup: string): string {
  return (policy?.createHTML(markup) ?? markup) as string;
}
