/**
 * Entry point of the lazily loaded extras bundle.
 *
 * What only a tap on a control needs, and no part of a first visit: the
 * sheet of the phone's bar (ui/mobileSheet.ts), which a phone fetches as
 * soon as the page has a moment, so it is there by the first tap (see
 * MobileBar), and the export of the map as an image (ui/mapExport.ts),
 * which Export fetches. Neither has a stylesheet of its own: the bar and
 * its sheet are drawn by styles.css, and the export draws nothing.
 * Whatever it uses has to be the app's or its own, as for the search (see
 * search.ts): a module it shared with another lazy bundle alone would get
 * a chunk of its own, which the site does not publish.
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
export { MobileSheet } from "./ui/mobileSheet";
export { exportImage } from "./ui/mapExport";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type ExtrasModule = typeof import("./extras");
