/**
 * The stylesheets of the lazily loaded bundles: one request per URL, a link
 * that stays once it applies, and a failure that is not kept.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  loadStylesheet,
  resetStylesheetLoader,
} from "../../../../flown/frontend/services/stylesheet";

describe("loadStylesheet", () => {
  /** Whatever a test appended, gone before the next one queries the head */
  afterEach(() => {
    resetStylesheetLoader();
    document.head
      .querySelectorAll('link[rel="stylesheet"]')
      .forEach((link) => link.remove());
  });

  it("appends a stylesheet link to document.head and resolves on load", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await loadStylesheet("test.css");

    const link = appendChildSpy.mock.calls[0]![0] as HTMLLinkElement;
    expect(link.tagName).toBe("LINK");
    expect(link.rel).toBe("stylesheet");
    expect(link.href).toContain("test.css");

    appendChildSpy.mockRestore();
  });

  it("leaves the link in the document, unlike a script", async () => {
    // A link only applies while it is in the head; removing it once it has
    // loaded, as a loader of scripts may, would undo the styles it brought in
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await loadStylesheet("kept.css");

    const link = document.head.querySelector('link[data-href="kept.css"]');
    expect(link).not.toBeNull();
    // and nothing left behind to fire later
    expect((link as HTMLLinkElement).onload).toBeNull();

    appendChildSpy.mockRestore();
  });

  it("does not add a second link for a href it already has", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await loadStylesheet("once.css");
    await loadStylesheet("once.css");

    expect(
      document.head.querySelectorAll('link[data-href="once.css"]'),
    ).toHaveLength(1);

    appendChildSpy.mockRestore();
  });

  it("rejects and takes the link back out on error", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onerror?.(new Event("error"));
        return node;
      });

    await expect(loadStylesheet("bad.css")).rejects.toThrow(
      "Failed to load stylesheet: bad.css",
    );
    expect(document.head.querySelector('link[data-href="bad.css"]')).toBeNull();

    appendChildSpy.mockRestore();
  });

  it("does not report a stylesheet that is still in flight as applied", async () => {
    // Deduping on the link being in the head said "loaded" for a request
    // that had not loaded, so a caller drew a panel the styles had not
    // reached yet. The second caller has to wait on the same request.
    vi.useFakeTimers();
    const links: HTMLLinkElement[] = [];
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        links.push(node as HTMLLinkElement);
        document.head.append(node);
        return node;
      });

    // Neither loads nor errors: still on the wire
    const first = loadStylesheet("features.css");
    first.catch(() => undefined);
    let settled = false;
    const second = loadStylesheet("features.css");
    void second.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(links).toHaveLength(1);
    expect(settled).toBe(false);

    // and it resolves once that one request does
    links[0]!.onload?.(new Event("load"));
    await expect(second).resolves.toBeUndefined();

    appendChildSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not let an abandoned attempt remove a later caller's stylesheet", async () => {
    // The bundle can fail while the sheet is still in flight, and the user
    // opens the feature again. Sharing one request means the timeout that
    // removes the link also rejects everyone waiting on it, instead of
    // pulling the stylesheet out from under a caller that was told it had
    // arrived.
    vi.useFakeTimers();
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        return node;
      });

    const first = loadStylesheet("features.css");
    first.catch(() => undefined);
    const second = loadStylesheet("features.css");
    const outcome = second.then(
      () => "resolved",
      () => "rejected",
    );

    vi.advanceTimersByTime(30_000);

    await expect(outcome).resolves.toBe("rejected");
    expect(
      document.head.querySelector('link[data-href="features.css"]'),
    ).toBeNull();

    appendChildSpy.mockRestore();
    vi.useRealTimers();
  });

  it("starts over after a failure instead of caching it", async () => {
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementationOnce((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onerror?.(new Event("error"));
        return node;
      })
      .mockImplementationOnce((node: Node) => {
        document.head.append(node);
        (node as HTMLLinkElement).onload?.(new Event("load"));
        return node;
      });

    await expect(loadStylesheet("retry.css")).rejects.toThrow();
    await expect(loadStylesheet("retry.css")).resolves.toBeUndefined();

    expect(appendChildSpy).toHaveBeenCalledTimes(2);
    appendChildSpy.mockRestore();
  });

  it("gives up on a stylesheet that neither loads nor errors", async () => {
    vi.useFakeTimers();
    const appendChildSpy = vi
      .spyOn(document.head, "appendChild")
      .mockImplementation((node: Node) => {
        document.head.append(node);
        return node;
      });

    const pending = loadStylesheet("stalled.css");
    vi.advanceTimersByTime(29_999);
    expect(
      document.head.querySelector('link[data-href="stalled.css"]'),
    ).not.toBeNull();
    vi.advanceTimersByTime(1);

    await expect(pending).rejects.toThrow(
      "Timed out loading stylesheet: stalled.css",
    );
    // Taken back out, so the next attempt is not short-circuited by it
    expect(
      document.head.querySelector('link[data-href="stalled.css"]'),
    ).toBeNull();

    appendChildSpy.mockRestore();
    vi.useRealTimers();
  });
});
