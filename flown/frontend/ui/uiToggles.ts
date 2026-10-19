/**
 * UI Toggles - Handles UI toggle functions (heatmap, altitude, airspeed, airports, aviation, satellite, export, share)
 */
import type { MapApp } from "../mapApp";
import { setControlLabel } from "../utils/buttonState";
import { canShareLink } from "../utils/device";
import { domCache } from "../utils/domCache";
import { loadedExtras, loadExtras } from "../services/featureLoader";
import { TRY_AGAIN } from "../services/lazyImport";
import { logError } from "../utils/logger";
import { dismissToast, showToast } from "../utils/toast";
import { SHARE_UNAVAILABLE_MESSAGE } from "../state/localFlags";
import {
  encodeStateToUrl,
  SHARE_INTRO_PARAM,
  SHARE_TOKEN_PARAM,
} from "../state/urlState";
import {
  EXPORT_BUSY_MESSAGE,
  exportRunning,
  NO_TIMING_MESSAGE,
  STILL_LOADING_MESSAGE,
} from "./actions";
import { altitudeColours, setColorLayer } from "./layerVisibility";
import { loadLazyBundle } from "./lazyBundles";

const EXPORT_BUTTON_LABEL = "Export image";
const EXPORT_BUTTON_BUSY_LABEL = "Exporting…";

/**
 * Said when an export fails. What failed goes to the console: html-to-image
 * rejects with an Event as often as with an Error, which read as
 * "[object Event]".
 */
export const EXPORT_FAILED_MESSAGE = "Could not export the image. Try again.";

/**
 * Said when the code of the export cannot be fetched: the extras bundle
 * (services/featureLoader.ts), or html-to-image (ui/mapExport.ts)
 */
export const EXPORT_UNAVAILABLE_MESSAGE =
  "Export is unavailable: its code could not be loaded" + TRY_AGAIN;

/**
 * Said when the link cannot be put on the clipboard, which the toast then
 * shows under the message to copy by hand
 */
export const COPY_FAILED_MESSAGE = "Could not copy link. Copy it from here:";

/** Whether a share sheet, or a download, was cancelled rather than failed */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * A link to hand on: without `debug`, as the token leaves it out, and
 * without a fragment the page writes no state to
 */
function shareable(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("debug");
  url.hash = "";
  return url.href;
}

export class UIToggles {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;
  }

  // The toggles only write the store: what the map shows, the buttons and
  // the legends follow it (see ui/layerVisibility.ts)

  toggleHeatmap(): void {
    if (this.app.map) this.app.heatmapVisible = !this.app.heatmapVisible;
  }

  toggleAltitude(): void {
    this.toggleColorLayer("altitude");
  }

  toggleAirspeed(): void {
    // Unavailable without timing data, and until the metadata says whether
    // there is any (aria-disabled, see appInitializer): a click says why
    // rather than turning on a layer with no speeds to draw
    if (!this.app.hasTimingData) {
      showToast(
        this.app.isInitializing ? STILL_LOADING_MESSAGE : NO_TIMING_MESSAGE,
      );
      return;
    }
    this.toggleColorLayer("airspeed");
  }

  private toggleColorLayer(mode: "altitude" | "airspeed"): void {
    if (!this.app.map) return;
    // A replay trail is always coloured by one of the two, altitude when
    // neither layer is on (see altitudeColours): the pair works as a choice
    // then, and switching the one on screen off switches to the other. A
    // plain flip of the altitude flag changed nothing on screen.
    if (this.app.replayActive && mode === "altitude") {
      if (altitudeColours(this.app)) {
        this.switchColorLayer("airspeed", true);
      } else {
        this.switchColorLayer("altitude", true);
      }
      return;
    }
    this.switchColorLayer(mode, !this.app[`${mode}Visible`]);
  }

  private switchColorLayer(
    mode: "altitude" | "airspeed",
    visible: boolean,
  ): void {
    if (setColorLayer(this.app, mode, visible)) {
      // "Disabled" is what the page says of a control that cannot be used
      const [off, on] =
        mode === "altitude"
          ? ["Groundspeed", "altitude"]
          : ["Altitude", "groundspeed"];
      showToast(`${off} off, colouring by ${on}`, "info");
    }
  }

  toggleAirports(): void {
    if (this.app.map) this.app.airportsVisible = !this.app.airportsVisible;
  }

  toggleAviation(): void {
    if (this.app.map) this.app.aviationVisible = !this.app.aviationVisible;
  }

  toggleSatellite(): void {
    if (this.app.map) this.app.satelliteVisible = !this.app.satelliteVisible;
  }

  /**
   * Capture the map as an image. Only the `#map` element is rendered, and
   * the controls are its siblings, so they never appear in the image and
   * nothing has to be hidden for it.
   */
  exportMap(): void {
    const btn = domCache.get("export-btn", HTMLButtonElement);
    const mapContainer = domCache.get("map");
    if (!btn || !mapContainer) return;
    // An export is already running, which a press is told rather than
    // ignored without a word
    if (exportRunning()) {
      showToast(EXPORT_BUSY_MESSAGE);
      return;
    }
    if (btn.getAttribute("aria-disabled") === "true") return;

    // Unavailable while it runs, but not `disabled`: that takes the focus
    // off the button that was just pressed and drops it to <body>
    btn.setAttribute("aria-disabled", "true");
    btn.setAttribute("data-busy", "");
    // Only the label changes so the button keeps its icon. Its name is its
    // aria-label, which says the same while it runs.
    const name = btn.getAttribute("aria-label");
    setControlLabel(btn, EXPORT_BUTTON_BUSY_LABEL);
    btn.setAttribute("aria-label", EXPORT_BUSY_MESSAGE);
    // The phone has no button to show it: the More sheet closed on the tap
    showToast(EXPORT_BUSY_MESSAGE);
    this.app.mobileBar?.refreshSheet();

    const restore = () => {
      btn.setAttribute("aria-disabled", "false");
      btn.removeAttribute("data-busy");
      setControlLabel(btn, EXPORT_BUTTON_LABEL);
      if (name) btn.setAttribute("aria-label", name);
      // The result's toast is up by now, or none for a cancelled share
      dismissToast(EXPORT_BUSY_MESSAGE);
      this.app.mobileBar?.refreshSheet();
    };

    // The share sheet's deadline counts from the tap (see exportImage)
    const tapped = Date.now();
    void loadLazyBundle(loadExtras, EXPORT_UNAVAILABLE_MESSAGE)
      .then((extras) => extras?.exportImage(this.app, mapContainer, tapped))
      .catch((error: unknown) => {
        logError("Export failed:", error);
        showToast(EXPORT_FAILED_MESSAGE, "error");
      })
      .finally(restore);
  }

  /**
   * Share the current view: the native share sheet in the phone layout,
   * whose row says "Share link" then (see MobileBar), otherwise the link
   * is copied to the clipboard. The column's control says "Copy link", and
   * desktop Safari and Chrome have a share sheet too, as have tablets and
   * touch laptops, which opened it instead of copying.
   */
  async shareLink(): Promise<void> {
    // The flights a visitor dropped are in this browser alone: a link to
    // the site would open on the site's flights, with a selection of ids
    // that are none of them
    if (this.app.config.localFlights) {
      showToast(SHARE_UNAVAILABLE_MESSAGE, "info");
      return;
    }
    // The URL is read right now, so the debounced save has to land first
    const state = this.app.stateManager.flush();
    // A link to shared flights draws them in as it opens, once (see
    // takeShareIntro), over the map: not under the statistics the sender
    // has open, which on a phone are a sheet over all of it. Share mode has
    // flights, so the link has a query.
    let url = shareable(location.href);
    /** The link with its token, once the code that packs it has come */
    let packed: Promise<string> | null = null;
    if (state) {
      const shared = this.app.isolateSelection;
      const query = shared
        ? `${encodeStateToUrl({
            ...state,
            statsPanelVisible: false,
            flightListVisible: false,
          })}&${SHARE_INTRO_PARAM}=1`
        : encodeStateToUrl(state);
      // All of it packed into one token (state/shareTokenPack.ts), which
      // the page resolves as it opens; the long link where the token has
      // no room. The code that packs it comes with the extras bundle, which
      // the page fetches once it has a moment (initMapApp) and pointing at
      // a share control fetches ahead (prepareOnIntent). Should a press
      // still beat it, the clipboard is handed the link to come, as it
      // takes one only in the moment of the press, which a fetch would
      // outlast in Safari; the share sheet takes the long link.
      const page = `${location.origin}${location.pathname}`;
      const long = shareable(shared ? `${page}?${query}` : location.href);
      const linkOf = (token: string | null | undefined): string =>
        token ? `${page}?${SHARE_TOKEN_PARAM}=${token}` : long;
      const extras = loadedExtras();
      url = linkOf(extras?.packShareToken(query));
      if (!extras) {
        packed = loadExtras().then(
          (loaded) => linkOf(loaded?.packShareToken(query)),
          () => long,
        );
      }
    }

    if (canShareLink()) {
      try {
        await navigator.share({ url, title: document.title });
        return;
      } catch (error) {
        if (isAbortError(error)) return;
        // Sharing failed: fall back to the clipboard
      }
    }

    try {
      if (packed && typeof ClipboardItem === "function") {
        const text = packed.then(
          (link) => new Blob([link], { type: "text/plain" }),
        );
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": text }),
        ]);
      } else {
        await navigator.clipboard.writeText(url);
      }
      showToast("Link copied", "info");
    } catch (_error) {
      // No clipboard over plain HTTP, in a frame or where it is refused:
      // the link to copy by hand from a field under the message
      // (styles.css), which a tap or Tab selects whole; the long one where
      // the token's code has not come, whose fetch may never end. Not in
      // the message, which is read out and replaces the toast of the last
      // failure; the link changes with every move of the map.
      const toast = showToast(COPY_FAILED_MESSAGE, "error");
      const link = document.createElement("input");
      link.className = "toast-link";
      link.readOnly = true;
      link.value = url;
      link.setAttribute("aria-label", "Link");
      // On focus by Tab, and again on a click or a tap, whose caret
      // undoes a selection made as it focused
      const all = () => link.setSelectionRange(0, link.value.length);
      link.onfocus = all;
      link.onpointerup = (event) => {
        event.preventDefault();
        all();
      };
      toast.append(link);
    }
  }
}
