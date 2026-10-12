/**
 * The page scrolled back once the keyboard of a phone has gone
 * (followKeyboard in ui/appChrome.ts)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followKeyboard } from "../../../../flown/frontend/ui/appChrome";

/** The visual viewport, whose resize the keyboard's coming and going is */
let viewport: EventTarget & { scale: number };
let controller: AbortController;

/** Give an element a scrollTop of its own, which jsdom keeps at 0 */
function scrollable(element: HTMLElement, top: number): void {
  let value = top;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next;
    },
  });
}

/** Scroll the page as Safari does under its keyboard */
function scrollPage(): void {
  scrollable(document.documentElement, 120);
  scrollable(document.body, 40);
}

function field(type: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  document.body.append(input);
  return input;
}

beforeEach(() => {
  vi.useFakeTimers();
  viewport = Object.assign(new EventTarget(), { scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  controller = new AbortController();
  followKeyboard(controller.signal);
});

afterEach(() => {
  controller.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  // The own properties go, and jsdom's 0 is back
  Reflect.deleteProperty(document.documentElement, "scrollTop");
  Reflect.deleteProperty(document.body, "scrollTop");
});

describe("followKeyboard", () => {
  it("scrolls the page back once the focus has left a field", () => {
    const input = field("search");
    input.focus();
    scrollPage();
    input.blur();

    // Not before the keyboard has had the time to go
    expect(document.documentElement.scrollTop).toBe(120);
    vi.runAllTimers();
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it("scrolls the page back as the visible part of the window grows", () => {
    scrollPage();
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it("leaves the page while a field that takes keys has the focus", () => {
    field("text").focus();
    scrollPage();
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.scrollTop).toBe(120);

    // Focus going from one field to the next keeps the keyboard up
    const next = field("search");
    next.focus();
    vi.runAllTimers();
    expect(document.documentElement.scrollTop).toBe(120);
  });

  it("scrolls back with a field focused that brings up no keyboard", () => {
    field("checkbox").focus();
    scrollPage();
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("leaves the page while it is pinched larger", () => {
    viewport.scale = 2;
    scrollPage();
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.scrollTop).toBe(120);
  });

  it("stops with its signal", () => {
    controller.abort();
    scrollPage();
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.scrollTop).toBe(120);
  });

  it("does nothing once its signal stopped it during the wait", () => {
    const input = field("search");
    input.focus();
    scrollPage();
    input.blur();
    controller.abort();
    vi.runAllTimers();
    expect(document.documentElement.scrollTop).toBe(120);
  });
});
