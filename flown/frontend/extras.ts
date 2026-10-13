/**
 * Entry point of the lazily loaded extras bundle.
 *
 * What no desktop's first visit needs: the phone's bar and its sheet
 * (ui/mobileBar.ts, ui/mobileSheet.ts), which the app mounts once the
 * phone layout applies (MapApp.followMobileBar); the export of the map as
 * an image (ui/mapExport.ts), which Export fetches; and the packing of
 * the tokens of shared links (state/shareTokenPack.ts) for Copy link,
 * which every page fetches once it has a moment (initMapApp) and pointing
 * at a share control fetches ahead of the press (prepareOnIntent); the
 * reading of a token is the first visit's. None has a stylesheet of its
 * own: the bar and its sheet are drawn by styles.css, and the rest draws
 * nothing.
 * Whatever it uses has to be the app's or its own, as for the search (see
 * search.ts): a module it shared with another lazy bundle alone would get
 * a chunk of its own, which the site does not publish.
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
export { MobileBar } from "./ui/mobileBar";
export { MobileSheet } from "./ui/mobileSheet";
export { exportImage } from "./ui/mapExport";
export { packShareToken } from "./state/shareTokenPack";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type ExtrasModule = typeof import("./extras");
