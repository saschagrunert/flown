import { describe, it, expect, vi } from "vitest";

interface Rules {
  createHTML(input: string): string;
  createScriptURL?(input: string): string | null;
}

/** A stand-in TrustedHTML, which a sink would take as it is */
class Made {
  constructor(readonly html: string) {}
}

/**
 * The module evaluated anew under a browser's trustedTypes, which jsdom
 * has none of; the rules of each policy it made, by name
 */
async function withTrustedTypes(): Promise<{
  module: typeof import("../../../../flown/frontend/utils/trustedHtml");
  rules: Map<string, Rules>;
}> {
  const rules = new Map<string, Rules>();
  vi.stubGlobal("trustedTypes", {
    createPolicy: (name: string, made: Rules) => {
      rules.set(name, made);
      return {
        createHTML: (input: string) => new Made(made.createHTML(input)),
      };
    },
  });
  vi.resetModules();
  const module = await import("../../../../flown/frontend/utils/trustedHtml");
  return { module, rules };
}

describe("trustedHtml", () => {
  it("is the markup as it is without Trusted Types", async () => {
    vi.resetModules();
    const { trustedHtml } =
      await import("../../../../flown/frontend/utils/trustedHtml");

    expect(trustedHtml("<b>x</b>")).toBe("<b>x</b>");
  });

  it("goes through the app's policy, which keeps the markup", async () => {
    const { module, rules } = await withTrustedTypes();

    expect([...rules.keys()]).toEqual(["flown", "default"]);
    expect(module.trustedHtml("<b>x</b>")).toEqual(new Made("<b>x</b>"));
  });
});

describe("the default policy", () => {
  it("keeps the links of a credit and makes any other markup text", async () => {
    const { rules } = await withTrustedTypes();
    const { createHTML } = rules.get("default")!;

    // MapLibre's close button of a popup and an attribution
    expect(createHTML("&#215;")).toBe("&#215;");
    const credit =
      '&copy; <a href="https://www.openflightmaps.org">open flightmaps</a>';
    expect(createHTML(credit)).toBe(credit);
    expect(createHTML('<A HREF="https://x">X</A >')).toBe(
      '<A HREF="https://x">X</A >',
    );
    expect(createHTML("<img src=x onerror=alert(1)><abbr>a</abbr>")).toBe(
      "&lt;img src=x onerror=alert(1)>&lt;abbr>a&lt;/abbr>",
    );
    // CARTO's credit
    const carto =
      '<a href="https://carto.com/about-carto/" target="_blank" rel="noopener">&copy; CARTO</a>';
    expect(createHTML(carto)).toBe(carto);
    expect(createHTML('<a title="<script>">')).toBe(
      '&lt;a title="&lt;script>">',
    );
    // A link that would run something is text as well
    expect(createHTML('<a href="https://x" onmouseover="alert(1)">x</a>')).toBe(
      '&lt;a href="https://x" onmouseover="alert(1)">x</a>',
    );
    expect(createHTML("<a href='javascript:alert(1)'>x</a>")).toBe(
      "&lt;a href='javascript:alert(1)'>x</a>",
    );
    expect(createHTML("<a/onfocus=alert(1) tabindex=0 autofocus>")).toBe(
      "&lt;a/onfocus=alert(1) tabindex=0 autofocus>",
    );
  });

  it("starts scripts of the page's own directory only", async () => {
    const { rules } = await withTrustedTypes();
    const createScriptURL = rules.get("default")!.createScriptURL!;
    const page = location.href;
    history.replaceState(null, "", "/flights/index.html");
    try {
      const own = new URL("/flights/vendor/maplibre-gl-worker.mjs?v=1", page);

      expect(createScriptURL(own.href)).toBe(own.href);
      expect(createScriptURL("./yearWorker.bundle.js")).toBe(
        "./yearWorker.bundle.js",
      );
      // Another site of the same origin, which 'self' would allow
      expect(createScriptURL("/other/worker.js")).toBeNull();
      expect(createScriptURL("../other/worker.js")).toBeNull();
      expect(
        createScriptURL("https://elsewhere.example/flights/x.js"),
      ).toBeNull();
      expect(createScriptURL("blob:https://elsewhere.example/1")).toBeNull();
    } finally {
      history.replaceState(null, "", page);
    }
  });
});
