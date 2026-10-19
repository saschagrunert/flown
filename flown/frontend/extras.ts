/**
 * Entry point of the lazily loaded extras bundle.
 *
 * What no first visit needs: the export of the map as an image
 * (ui/mapExport.ts), which Export fetches; the packing of the tokens of
 * shared links (state/shareTokenPack.ts) for Copy link, which every page
 * fetches once it has a moment (initMapApp) and pointing at a share
 * control fetches ahead of the press (prepareOnIntent); the reading of a
 * token is the first visit's; and the flight list of an airport's popup
 * (ui/airportFlights.ts), which a popup opened before the bundle came
 * waits for (AirportManager.listPopupFlights). The list is drawn by
 * extras.css, which services/featureLoader.ts fetches with the bundle; the
 * rest draws nothing. The bundle is there once both have come, so a
 * stylesheet that does not come takes all of it away, as a bundle that
 * does not would: the same build puts both next to each other. The phone's
 * bar and sheet are a bundle of their own (phone.ts), which a desktop does
 * not fetch.
 * Whatever it uses has to be the app's or its own, as for the search (see
 * search.ts): a module it shared with another lazy bundle alone would get
 * a chunk of its own, which the site does not publish.
 *
 * The app is imported for the bundler's sake: see features.ts.
 */
import "./mapApp";
export { exportImage } from "./ui/mapExport";
export { packShareToken } from "./state/shareTokenPack";
export { listFlights } from "./ui/airportFlights";

/**
 * The build this bundle belongs to, which the app compares with its own
 * (services/featureLoader.ts): a page open over a deploy gets this file of
 * the new build, next to the old build's shared.bundle.js
 */
export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

/** What the bundle hands the app: every export of this module */
export type ExtrasModule = typeof import("./extras");
