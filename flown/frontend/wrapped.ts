/**
 * Entry point of the lazily loaded Wrapped bundle.
 *
 * Wrapped is only needed once its dialog opens, which says nothing about
 * replay, so it is an entry point of its own rather than part of the
 * feature bundle (see services/featureLoader.ts). Everything it shares with
 * the app lives in shared.bundle.js, so this bundle adds only Wrapped.
 *
 * The statistics panel rides along: most visits never open it either, and
 * it needs most of what Wrapped computes. A bundle of its own would share
 * those modules with Wrapped and not with the app, which makes esbuild
 * write a chunk the site does not publish (assertExpectedOutputs in
 * build.js). The app loads it the first time the panel opens
 * (ui/statsPanel.ts). The flight list, the rail's other tab, comes with the
 * stats manager (ui/flightList.ts).
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
export { StatsManager } from "./ui/statsManager";
export { WrappedManager } from "./ui/wrappedManager";
export { prepareWrappedIntro } from "./ui/wrappedIntro";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type WrappedModule = typeof import("./wrapped");
