/**
 * Entry point of the lazily loaded search bundle.
 *
 * The search of airports and places is only needed once its control is
 * pressed (or `/` typed), which says nothing about replay or Wrapped, so it
 * is an entry point of its own (see services/featureLoader.ts): the first
 * visit carries the button and the key, and this bundle the panel, the
 * matching of the site's airports and the client of the geocoder.
 * Everything it shares with the app lives in shared.bundle.js. Whatever it
 * uses has to be the app's or its own: a module it shared with the feature
 * or the Wrapped bundle alone would get a chunk of its own, which the site
 * does not publish (assertExpectedOutputs in build.js). That is why the
 * name of a country comes from utils/formatters.ts, which the app reaches,
 * rather than from features/countries.ts, which only Wrapped uses.
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
export { toggleSearch } from "./ui/locationSearch";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type SearchModule = typeof import("./search");
