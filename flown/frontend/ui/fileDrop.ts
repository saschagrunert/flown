/**
 * The sheet over the map while files are dragged across the page: it says
 * where they go, and the drop opens Your flights with them
 * (ui/localFlights.ts). The app watches for the drag and brings this in
 * (ui/fileDropWatch.ts).
 */

import type { MapApp } from "../mapApp";
import { icon } from "../utils/icons";
import { carriesFiles } from "./fileDropWatch";

export const DROP_SHEET_ID = "file-drop-sheet";
export const DROP_MESSAGE = "Drop the files to see your flights";

let sheet: HTMLElement | null = null;
/** Puts the sheet's count of the drag's depth at one (see showDropSheet) */
let reset: () => void = () => {};

/**
 * Show the sheet; it goes when the drag leaves the window or drops, and
 * comes back with the next drag of files. The drop itself is the window's
 * (fileDropWatch.ts), so a drop lands the same with or without the sheet.
 */
export function showDropSheet(
  app: Pick<MapApp, "signal" | "toggleLocalFlights">,
): HTMLElement {
  if (!sheet) {
    const made = document.createElement("div");
    made.id = DROP_SHEET_ID;
    made.className = "file-drop-sheet";
    made.setAttribute("aria-hidden", "true");
    made.innerHTML =
      '<div class="file-drop-sheet-box">' +
      icon("upload", 24) +
      `<span>${DROP_MESSAGE}</span></div>`;
    document.body.append(made);
    sheet = made;
    const signal = app.signal;
    // How many elements deep the drag is: every element entered fires a
    // dragenter before the one left fires its dragleave, so the count is
    // back at zero only when the drag has left the window (a dragleave
    // within the page may carry no relatedTarget in Chromium). The sheet
    // is shown while the drag is over an element already, whose dragenter
    // came before this listener: one deep from the start (see below).
    let depth = 1;
    const hide = (): void => {
      depth = 0;
      made.hidden = true;
    };
    window.addEventListener(
      "dragenter",
      (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        depth++;
        made.hidden = false;
      },
      { signal },
    );
    window.addEventListener(
      "dragleave",
      (event) => {
        if (!carriesFiles(event.dataTransfer)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) hide();
      },
      { signal },
    );
    window.addEventListener("drop", hide, { signal });
    window.addEventListener("dragend", hide, { signal });
    signal.addEventListener("abort", () => {
      made.remove();
      if (sheet === made) sheet = null;
    });
    reset = () => {
      depth = 1;
    };
  }
  // Shown for a drag that is over an element of the page
  reset();
  sheet.hidden = false;
  return sheet;
}
