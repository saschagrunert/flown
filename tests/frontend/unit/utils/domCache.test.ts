import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DOMCache } from "../../../../flown/frontend/utils/domCache";
import {
  hideControls,
  restoreControls,
} from "../../../../flown/frontend/ui/wrappedChrome";

describe("DOMCache", () => {
  let domCache: DOMCache;

  beforeEach(() => {
    // Clear DOM
    document.body.innerHTML = "";
    // Create new cache instance for each test
    domCache = new DOMCache();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("get", () => {
    it("returns element when found in DOM", () => {
      const element = document.createElement("div");
      element.id = "test-element";
      document.body.appendChild(element);

      const result = domCache.get("test-element");

      expect(result).toBe(element);
      expect(result?.id).toBe("test-element");
    });

    it("returns null when element not found", () => {
      const result = domCache.get("non-existent");

      expect(result).toBeNull();
    });

    it("caches element on first access", () => {
      const element = document.createElement("div");
      element.id = "cached-element";
      document.body.appendChild(element);
      const lookup = vi.spyOn(document, "getElementById");

      domCache.get("cached-element");
      domCache.get("cached-element");

      expect(lookup).toHaveBeenCalledTimes(1);
      lookup.mockRestore();
    });

    it("returns cached element on subsequent access", () => {
      const element = document.createElement("div");
      element.id = "cached-element";
      document.body.appendChild(element);

      const first = domCache.get("cached-element");
      const second = domCache.get("cached-element");

      expect(first).toBe(second);
      expect(first).toBe(element);
    });

    it("invalidates cache when element is removed from DOM", () => {
      const element = document.createElement("div");
      element.id = "removable";
      document.body.appendChild(element);

      expect(domCache.get("removable")).toBe(element);

      // Remove element from DOM
      document.body.removeChild(element);

      const result = domCache.get("removable");

      expect(result).toBeNull();
    });

    it("re-caches element if it's added back after removal", () => {
      const element1 = document.createElement("div");
      element1.id = "replaceable";
      document.body.appendChild(element1);

      domCache.get("replaceable");
      document.body.removeChild(element1);
      domCache.get("replaceable"); // Triggers cache invalidation

      const element2 = document.createElement("div");
      element2.id = "replaceable";
      document.body.appendChild(element2);

      const result = domCache.get("replaceable");

      expect(result).toBe(element2);
      expect(result).not.toBe(element1);
    });
  });

  describe("get with an element class", () => {
    it("returns the element when it is an instance of the class", () => {
      const select = document.createElement("select");
      select.id = "year-select";
      document.body.appendChild(select);

      const result = domCache.get("year-select", HTMLSelectElement);

      expect(result).toBe(select);
      // The narrowed type is what callers rely on
      expect(result?.options).toBeDefined();
    });

    it("returns null when the element is of another class", () => {
      const div = document.createElement("div");
      div.id = "year-select";
      document.body.appendChild(div);

      expect(domCache.get("year-select", HTMLSelectElement)).toBeNull();
      expect(domCache.get("year-select", HTMLButtonElement)).toBeNull();
      // The untyped lookup still finds it
      expect(domCache.get("year-select")).toBe(div);
    });

    it("returns null when the element is missing", () => {
      expect(domCache.get("missing", HTMLButtonElement)).toBeNull();
    });
  });

  describe("performance benefits", () => {
    it("reduces DOM queries for frequently accessed elements", () => {
      const element = document.createElement("div");
      element.id = "frequent";
      document.body.appendChild(element);

      // First access - queries DOM and caches
      const result1 = domCache.get("frequent");

      // Subsequent accesses use cache
      const result2 = domCache.get("frequent");
      const result3 = domCache.get("frequent");
      const result4 = domCache.get("frequent");

      expect(result1).toBe(element);
      expect(result2).toBe(element);
      expect(result3).toBe(element);
      expect(result4).toBe(element);

      // All access the same cached reference
      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
      expect(result3).toBe(result4);
    });
  });
});

describe("hideControls / restoreControls", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("hides control elements and saves their original display values", () => {
    const el = document.createElement("div");
    el.id = "left-buttons";
    el.style.display = "block";
    document.body.appendChild(el);

    const saved = hideControls();

    expect(el.style.display).toBe("none");
    expect(saved.size).toBeGreaterThanOrEqual(1);
    expect(saved.get(el)).toBe("block");
  });

  it("restoreControls restores original display values", () => {
    const el = document.createElement("div");
    el.id = "left-buttons";
    el.style.display = "flex";
    document.body.appendChild(el);

    const saved = hideControls();
    expect(el.style.display).toBe("none");

    restoreControls(saved);
    expect(el.style.display).toBe("flex");
  });

  it("restores empty string display (browser default)", () => {
    const el = document.createElement("div");
    el.id = "left-buttons";
    document.body.appendChild(el);

    const saved = hideControls();
    expect(el.style.display).toBe("none");

    restoreControls(saved);
    expect(el.style.display).toBe("");
  });

  it("returns empty map when no elements exist", () => {
    const saved = hideControls();
    expect(saved.size).toBe(0);
  });

  it("restoreControls with empty map is a no-op", () => {
    const saved = new Map<HTMLElement, string>();
    expect(() => restoreControls(saved)).not.toThrow();
  });
});
