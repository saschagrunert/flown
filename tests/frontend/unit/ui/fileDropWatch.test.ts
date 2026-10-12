/**
 * The watch for files dragged over the page (ui/fileDropWatch.ts): the app
 * brings in the bundle of Your flights on the first drag and hands a drop
 * to the panel, with or without the sheet the bundle draws.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MapApp } from "../../../../flown/frontend/mapApp";
import {
  carriesFiles,
  watchFileDrops,
} from "../../../../flown/frontend/ui/fileDropWatch";
import { logError } from "../../../../flown/frontend/utils/logger";

vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

type DragLike = Event & { dataTransfer: unknown };

/** A drag event of jsdom, which has no DragEvent with a dataTransfer */
function drag(type: string, transfer: unknown): DragLike {
  const event = new Event(type, { cancelable: true }) as DragLike;
  event.dataTransfer = transfer;
  return event;
}

const FILES = { types: ["Files"], files: [new File(["x"], "a.kml")] };

type AppLike = Pick<MapApp, "signal" | "toggleLocalFlights">;

let app: AppLike & {
  toggleLocalFlights: ReturnType<typeof vi.fn<MapApp["toggleLocalFlights"]>>;
};
let controller: AbortController;

beforeEach(() => {
  controller = new AbortController();
  app = {
    signal: controller.signal,
    toggleLocalFlights: vi.fn<MapApp["toggleLocalFlights"]>(),
  };
});

// The watch of the test before goes with its app, or its listeners would
// take the drags of the next
afterEach(() => controller.abort());

describe("carriesFiles", () => {
  it("is true for a drag of files only", () => {
    expect(carriesFiles(null)).toBe(false);
    expect(
      carriesFiles({ types: ["text/plain"] } as unknown as DataTransfer),
    ).toBe(false);
    expect(
      carriesFiles({
        types: ["text/uri-list", "Files"],
      } as unknown as DataTransfer),
    ).toBe(true);
  });
});

describe("watchFileDrops", () => {
  it("loads the bundle on the first drag of files and shows its sheet", async () => {
    const showDropSheet = vi.fn();
    const load = vi.fn().mockResolvedValue({ showDropSheet });
    watchFileDrops(app, load);

    window.dispatchEvent(drag("dragenter", FILES));
    window.dispatchEvent(drag("dragenter", FILES));
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
    expect(showDropSheet).toHaveBeenCalledWith(app);
  });

  it("brings the sheet in once; its own listeners show it for later drags", async () => {
    const showDropSheet = vi.fn();
    const load = vi.fn().mockResolvedValue({ showDropSheet });
    watchFileDrops(app, load);

    window.dispatchEvent(drag("dragenter", FILES));
    await vi.waitFor(() => expect(showDropSheet).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(drag("dragenter", FILES));
    await Promise.resolve();
    await Promise.resolve();

    expect(load).toHaveBeenCalledTimes(1);
    expect(showDropSheet).toHaveBeenCalledTimes(1);
  });

  it("tries again on the next drag when the bundle did not come", async () => {
    const load = vi.fn().mockResolvedValue(null);
    watchFileDrops(app, load);

    window.dispatchEvent(drag("dragenter", FILES));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(drag("dragenter", FILES));

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores a drag without files", () => {
    const load = vi.fn();
    watchFileDrops(app, load);

    window.dispatchEvent(drag("dragenter", { types: ["text/plain"] }));
    window.dispatchEvent(drag("dragenter", null));

    expect(load).not.toHaveBeenCalled();
  });

  it("logs a load that fails", async () => {
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    watchFileDrops(app, load);

    window.dispatchEvent(drag("dragenter", FILES));
    await vi.waitFor(() => expect(logError).toHaveBeenCalled());
  });

  it("lets files be dropped by preventing the default of their dragover", () => {
    watchFileDrops(app, vi.fn());

    const files = drag("dragover", FILES);
    window.dispatchEvent(files);
    const text = drag("dragover", { types: ["text/plain"] });
    window.dispatchEvent(text);

    expect(files.defaultPrevented).toBe(true);
    expect(text.defaultPrevented).toBe(false);
  });

  it("hands dropped files to the panel, and nothing to an empty drop", () => {
    watchFileDrops(app, vi.fn());

    const drop = drag("drop", FILES);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(app.toggleLocalFlights).toHaveBeenCalledWith(FILES.files);

    window.dispatchEvent(drag("drop", { types: ["Files"], files: [] }));
    const text = drag("drop", { types: ["text/plain"] });
    window.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    expect(app.toggleLocalFlights).toHaveBeenCalledTimes(1);
  });

  it("leaves a drop the panel's own zone took already", () => {
    watchFileDrops(app, vi.fn());

    const taken = drag("drop", FILES);
    taken.preventDefault();
    window.dispatchEvent(taken);

    expect(app.toggleLocalFlights).not.toHaveBeenCalled();
  });

  it("stops watching with the app", () => {
    const load = vi.fn().mockResolvedValue(null);
    watchFileDrops(app, load);
    controller.abort();

    window.dispatchEvent(drag("dragenter", FILES));
    window.dispatchEvent(drag("drop", FILES));

    expect(load).not.toHaveBeenCalled();
    expect(app.toggleLocalFlights).not.toHaveBeenCalled();
  });
});
