/**
 * Entry point of the lazily loaded phone bundle.
 *
 * The phone's bar and its sheet (ui/mobileBar.ts, ui/mobileSheet.ts), which
 * the app mounts once the phone layout applies (MapApp.followMobileBar): a
 * phone asks for them as the page starts, a desktop only when its window
 * turns into the phone layout. They were part of the extras bundle, which
 * every page fetches once it has a moment, and were most of it. The sheet
 * is drawn by phone.css, which services/featureLoader.ts fetches with the
 * bundle, and the bar by styles.css. The bundle is there once both have
 * come, so a stylesheet that does not come takes all of it away, as a
 * bundle that does not would: the same build puts both next to each other.
 * Whatever it uses has to be the app's or its own, as for the search (see
 * search.ts): a module it shared with another lazy bundle alone would get
 * a chunk of its own, which the site does not publish.
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
export { MobileBar } from "./ui/mobileBar";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type PhoneModule = typeof import("./phone");
