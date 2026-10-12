import { describe, it, expect, afterEach, vi } from "vitest";

/** A fresh module per test: the media query is created once per module */
async function loadMotion(
  matchMedia: unknown,
): Promise<typeof import("../../../../flown/frontend/utils/motion")> {
  Object.defineProperty(window, "matchMedia", {
    value: matchMedia,
    configurable: true,
  });
  vi.resetModules();
  return import("../../../../flown/frontend/utils/motion");
}

describe("prefersReducedMotion", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("follows the reduced motion media query", async () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    }));
    const { prefersReducedMotion } = await loadMotion(matchMedia);

    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("is false when the query does not match", async () => {
    const { prefersReducedMotion } = await loadMotion(() => ({
      matches: false,
    }));

    expect(prefersReducedMotion()).toBe(false);
  });

  it("creates the media query once and follows its changes", async () => {
    const list = { matches: false };
    const matchMedia = vi.fn(() => list);
    const { prefersReducedMotion } = await loadMotion(matchMedia);

    expect(prefersReducedMotion()).toBe(false);
    list.matches = true;
    expect(prefersReducedMotion()).toBe(true);
    expect(matchMedia).toHaveBeenCalledTimes(1);
  });

  it("asks a replaced matchMedia anew, like every other query", async () => {
    const { prefersReducedMotion } = await loadMotion(() => ({
      matches: false,
    }));
    expect(prefersReducedMotion()).toBe(false);

    const replaced = vi.fn(() => ({ matches: true }));
    Object.defineProperty(window, "matchMedia", {
      value: replaced,
      configurable: true,
    });

    expect(prefersReducedMotion()).toBe(true);
    expect(replaced).toHaveBeenCalledTimes(1);
  });

  it("is false without matchMedia", async () => {
    const { prefersReducedMotion } = await loadMotion(undefined);

    expect(prefersReducedMotion()).toBe(false);
  });
});
