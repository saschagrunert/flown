/**
 * The entry point of the bundle of Your flights: the panel that takes the
 * KML files a visitor drops on the page and shows them in place of the
 * site's (ui/localFlights.ts), the sheet over the map while files are
 * dragged across it (ui/fileDrop.ts), and the configuration a page that
 * shows those flights starts with. The app fetches it the first time the
 * panel opens or a file is dragged over the page, and at start when the
 * page shows the visitor's flights (services/featureLoader.ts).
 */

import "./mapApp";
export {
  localStartConfig,
  reopenAfterSwitch,
  toggleLocalFlights,
} from "./ui/localFlights";
export { showDropSheet } from "./ui/fileDrop";

export const BUILD = typeof __BUILD__ === "string" ? __BUILD__ : undefined;

export type LocalModule = typeof import("./local");
