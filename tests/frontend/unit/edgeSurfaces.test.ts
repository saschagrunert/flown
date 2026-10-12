import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The surfaces across the whole width of the map on a phone are a hair
 * short of opaque (--color-bg-edge in styles.css). Chrome leaves out the
 * part of the map's canvas an opaque element across a whole edge covers,
 * and the same strip at the opposite edge with it: the top of the map
 * showed the page background as high as the tab bar. Only a screenshot of
 * a phone-sized page shows it, which the visual snapshots take; this pins
 * the surfaces to the token, and the token below opaque. The statistics
 * sheet is opaque: at 0.99 the labels of the map showed through it, and
 * its rounded top corners keep Chrome from taking it for such an edge.
 */

/** The phone layout's breakpoint in styles.css */
const PHONE = "(max-width: 767.98px), (max-height: 480px)";

/** The surfaces that span the whole width of the map on a phone */
const EDGE_SURFACES = [".mobile-bar", ".mobile-sheet"];

describe("the surfaces across the map's edges on a phone", () => {
  let style: HTMLStyleElement;
  let rules: CSSRule[];

  beforeAll(() => {
    style = document.createElement("style");
    style.textContent = readFileSync(
      resolve(__dirname, "../../../flown/static/styles.css"),
      "utf8",
    );
    document.head.append(style);
    rules = [...style.sheet!.cssRules];
  });

  afterAll(() => {
    style.remove();
  });

  /** The style rules for `selector` alone, at the top level or in `media` */
  function rulesFor(selector: string, media: string | null): CSSStyleRule[] {
    const within =
      media === null
        ? rules
        : rules
            .filter(
              (rule): rule is CSSMediaRule =>
                rule instanceof CSSMediaRule && rule.media.mediaText === media,
            )
            .flatMap((rule) => [...rule.cssRules]);
    return within.filter(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule &&
        rule.selectorText.split(",").some((one) => one.trim() === selector),
    );
  }

  it("draws them in the edge's surface colour", () => {
    for (const selector of EDGE_SURFACES) {
      const backgrounds = rulesFor(selector, PHONE)
        .map((rule) => rule.style.getPropertyValue("background-color"))
        .filter(Boolean);
      expect(backgrounds, selector).toEqual(["var(--color-bg-edge)"]);
    }
  });

  it("has no other background given them anywhere else", () => {
    // The desktop rail is a column down the left edge, which Chrome leaves
    // as it is, and has a rule of its own
    for (const selector of [".mobile-bar", ".mobile-sheet"]) {
      for (const media of [null, PHONE]) {
        for (const rule of rulesFor(selector, media)) {
          const background =
            rule.style.getPropertyValue("background-color") ||
            rule.style.getPropertyValue("background");
          if (background) {
            expect(background, selector).toBe("var(--color-bg-edge)");
          }
        }
      }
    }
  });

  it("draws the statistics sheet opaque, with the rounded corners that let it", () => {
    const [sheet, ...others] = rulesFor("#stats-rail:not([hidden])", PHONE);
    expect(others).toEqual([]);
    expect(sheet!.style.getPropertyValue("background-color")).toBe(
      "var(--color-bg-secondary)",
    );
    expect(sheet!.style.getPropertyValue("border-radius")).toBe(
      "var(--radius-sheet) var(--radius-sheet) 0 0",
    );
  });

  it("keeps that colour short of opaque, and the secondary surface", () => {
    const root = rulesFor(":root", null);
    const edge = root
      .map((rule) => rule.style.getPropertyValue("--color-bg-edge").trim())
      .find(Boolean);
    const match = /^rgba\(var\(--color-bg-secondary-rgb\),\s*([\d.]+)\)$/.exec(
      edge ?? "",
    );
    expect(match, edge).not.toBeNull();
    const alpha = Number(match![1]);
    expect(alpha).toBeLessThan(1);
    // Not a tint anyone would see through
    expect(alpha).toBeGreaterThanOrEqual(0.99);
  });
});
