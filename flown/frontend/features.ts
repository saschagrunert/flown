/**
 * Entry point of the lazily loaded feature bundle.
 *
 * Replay is a large part of the code and most visits never open it, so it
 * is an entry point of its own that the app imports the first time it is
 * used (see services/featureLoader.ts). Everything it shares with the app
 * lives in shared.bundle.js, so this bundle adds only replay itself (of one
 * flight and of all of them at once), the relief, the heat cloud and the
 * ribbons of the 3D view, of every flight and of a selection, which the
 * layer manager fetches as they are first wanted, the satellite imagery,
 * which its switch fetches, the profile of the selected flights, which the
 * app fetches as a few are first selected, the cross-section, which its
 * control fetches, the hotspot tour with the camera moves it shares
 * with Wrapped's intro, and the intro of a link to shared flights, which
 * the app fetches as such a link opens, and the camera that frames the
 * flights of share mode and a flight picked from a list as the map is
 * tilted.
 * Wrapped has a bundle of its own (wrapped.ts) and fetches this one only
 * for its intro's camera moves and heat cloud.
 *
 * The app is imported for the bundler's sake. esbuild puts every module in
 * a chunk by the set of entry points that reach it, so with five of them a
 * module the app shares with replay and not with Wrapped or the search
 * would get a chunk of its own, and each such chunk would be one more file
 * on the first visit under the same fixed name. Reaching the app from every
 * lazy entry point gives all of it the same set, so the app is one chunk
 * (shared.bundle.js) and each lazy bundle is left with only its own code.
 * The module runs once all the same: by the time this bundle is imported,
 * the page has run it.
 */
import "./mapApp";
export { ReplayManager } from "./ui/replayManager";
export { followTerrain } from "./ui/terrain";
export { followSatellite } from "./ui/satellite";
export { followHeatCloud, prepareHeatCloud } from "./ui/heatCloud";
export { followSelectionRibbons } from "./ui/selectionRibbons";
export {
  ribbonBox,
  ribbonFeatures,
  ribbonLiftPx,
  viewLeaves,
} from "./ui/pathRibbons";
export { followsLevel } from "./calculations/lift";
export {
  heldGroundedFlights,
  releaseGroundedFlights,
  releaseGroundProfiles,
} from "./calculations/groundProfile";
export { ReplayAllPlayer } from "./ui/replayAllPlayer";
export { toggleReplayAll } from "./ui/replayAll";
export { followFlightProfile } from "./ui/flightProfile";
export { toggleCrossSection } from "./ui/crossSection";
export {
  flyToStop,
  followTakeover,
  jumpToStop,
  turnTo,
} from "./ui/cameraScript";
export { toggleHotspotTour } from "./ui/hotspotTour";
export { playShareIntro } from "./ui/shareIntro";
export { frameFlights } from "./ui/frameFlights";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type FeatureModule = typeof import("./features");
