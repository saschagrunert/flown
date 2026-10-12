/**
 * Files dragged over the page land in Your flights (ui/localFlights.ts).
 *
 * The app listens for the first drag of files over the window and brings
 * in the bundle of Your flights, which draws a sheet over the map that says
 * where the files go (showDropSheet in ui/fileDrop.ts). A drop that lands
 * before the bundle has arrived is taken as well: the window hands the
 * files to the panel, which opens with them once it is there.
 */

import type { MapApp } from "../mapApp";
import { logError } from "../utils/logger";

/** Whether a drag carries files, rather than text or a link */
export function carriesFiles(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types).includes("Files");
}

export interface DropSheetModule {
  showDropSheet(app: Pick<MapApp, "signal" | "toggleLocalFlights">): unknown;
}

export function watchFileDrops(
  app: Pick<MapApp, "signal" | "toggleLocalFlights">,
  load: () => Promise<DropSheetModule | null>,
): void {
  const signal = app.signal;
  let loading = false;
  let shown = false;
  window.addEventListener(
    "dragenter",
    (event) => {
      // Once up, the sheet shows itself for every later drag
      if (!carriesFiles(event.dataTransfer) || loading || shown) return;
      loading = true;
      load()
        .then((module) => {
          if (!module) return;
          module.showDropSheet(app);
          shown = true;
        })
        .catch(logError)
        .finally(() => {
          loading = false;
        });
    },
    { signal },
  );
  window.addEventListener(
    "dragover",
    (event) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault();
    },
    { signal },
  );
  window.addEventListener(
    "drop",
    (event) => {
      // The panel's own zone takes its drops (ui/localFlights.ts)
      if (!carriesFiles(event.dataTransfer) || event.defaultPrevented) return;
      event.preventDefault();
      const files = event.dataTransfer?.files;
      if (files?.length) app.toggleLocalFlights(files);
    },
    { signal },
  );
}
