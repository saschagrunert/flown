/**
 * The sheet over the map while files are dragged across the page
 * (ui/fileDrop.ts): one for the page, shown with a drag of files, gone
 * with the drop or the drag leaving the window, and gone for good with the
 * app.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MapApp } from "../../../../flown/frontend/mapApp";
import {
  DROP_MESSAGE,
  DROP_SHEET_ID,
  showDropSheet,
} from "../../../../flown/frontend/ui/fileDrop";

type DragLike = Event & { dataTransfer?: unknown; relatedTarget?: unknown };

function drag(
  type: string,
  transfer?: unknown,
  relatedTarget?: unknown,
): DragLike {
  const event = new Event(type) as DragLike;
  if (transfer !== undefined) event.dataTransfer = transfer;
  event.relatedTarget = relatedTarget ?? null;
  return event;
}

const FILES = { types: ["Files"], files: [] };

let controller: AbortController;
type AppLike = Pick<MapApp, "signal" | "toggleLocalFlights">;

let app: AppLike & {
  toggleLocalFlights: ReturnType<typeof vi.fn<MapApp["toggleLocalFlights"]>>;
};

const sheet = (): HTMLElement | null => document.getElementById(DROP_SHEET_ID);

beforeEach(() => {
  // A sheet of the test before goes with its app
  document.getElementById(DROP_SHEET_ID)?.remove();
  controller = new AbortController();
  app = {
    signal: controller.signal,
    toggleLocalFlights: vi.fn<MapApp["toggleLocalFlights"]>(),
  };
});

describe("showDropSheet", () => {
  it("makes one sheet with the message, shown, and shows the same again", () => {
    const made = showDropSheet(app);

    expect(made).toBe(sheet());
    expect(made.hidden).toBe(false);
    expect(made.getAttribute("aria-hidden")).toBe("true");
    expect(made.textContent).toContain(DROP_MESSAGE);
    expect(made.querySelector("svg")).not.toBeNull();

    made.hidden = true;
    expect(showDropSheet(app)).toBe(made);
    expect(made.hidden).toBe(false);
    expect(document.querySelectorAll(`#${DROP_SHEET_ID}`)).toHaveLength(1);
    controller.abort();
  });

  it("goes with the drop, the end of the drag and the drag leaving the window", () => {
    const made = showDropSheet(app);

    window.dispatchEvent(drag("drop"));
    expect(made.hidden).toBe(true);
    made.hidden = false;

    window.dispatchEvent(drag("dragend"));
    expect(made.hidden).toBe(true);
    made.hidden = false;

    // Shown for a drag over an element of the page already, one deep.
    // Into another element: its dragenter comes before the dragleave of
    // the one left, so the drag is still over the window
    showDropSheet(app);
    window.dispatchEvent(drag("dragenter", FILES));
    window.dispatchEvent(drag("dragleave", FILES));
    expect(made.hidden).toBe(false);
    // A dragleave of text counts for nothing
    window.dispatchEvent(drag("dragleave", { types: ["text/plain"] }));
    expect(made.hidden).toBe(false);
    window.dispatchEvent(drag("dragleave", FILES));
    expect(made.hidden).toBe(true);
    // Shown again from the start: one leave hides it
    window.dispatchEvent(drag("dragenter", FILES));
    expect(made.hidden).toBe(false);
    window.dispatchEvent(drag("dragleave", FILES));
    expect(made.hidden).toBe(true);
    // Shown again by the page: one deep again, whatever the count was
    window.dispatchEvent(drag("dragenter", FILES));
    window.dispatchEvent(drag("dragenter", FILES));
    showDropSheet(app);
    window.dispatchEvent(drag("dragleave", FILES));
    expect(made.hidden).toBe(true);
    controller.abort();
  });

  it("comes back with the next drag of files, not with one of text", () => {
    const made = showDropSheet(app);
    made.hidden = true;

    window.dispatchEvent(drag("dragenter", { types: ["text/plain"] }));
    expect(made.hidden).toBe(true);
    window.dispatchEvent(drag("dragenter", FILES));
    expect(made.hidden).toBe(false);
    controller.abort();
  });

  it("is removed with the app, and the next app gets a new one", () => {
    const made = showDropSheet(app);

    controller.abort();

    expect(made.isConnected).toBe(false);
    expect(sheet()).toBeNull();

    const next = new AbortController();
    const again = showDropSheet({ ...app, signal: next.signal });
    expect(again).not.toBe(made);
    expect(again.isConnected).toBe(true);
    next.abort();
  });
});
