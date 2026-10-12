import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  applyToggleButtonState,
  setControlLabel,
  setUnavailable,
  syncLegend,
  syncToggleButton,
} from "../../../../flown/frontend/utils/buttonState";
import { AppStore } from "../../../../flown/frontend/state/store";

describe("buttonState", () => {
  let button: HTMLButtonElement;

  beforeEach(() => {
    button = document.createElement("button");
    button.id = "heatmap-btn";
    document.body.appendChild(button);
  });

  afterEach(() => {
    button.remove();
  });

  describe("applyToggleButtonState", () => {
    it("sets aria-pressed and the active class for an active button", () => {
      applyToggleButtonState(button, true);

      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.classList.contains("active")).toBe(true);
      expect(button.style.opacity).toBe("");
    });

    it("clears them for an inactive button, without dimming it", () => {
      button.classList.add("active");

      applyToggleButtonState(button, false);

      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.classList.contains("active")).toBe(false);
      // Off is not unavailable: an inline 0.5 made the two look alike, and
      // an inline 1.0 beat the stylesheet's look for a disabled control
      expect(button.style.opacity).toBe("");
    });
  });

  describe("syncToggleButton", () => {
    it("applies the current store value immediately", () => {
      const store = new AppStore({ heatmapVisible: false });

      syncToggleButton(store, "heatmapVisible", "heatmap-btn");

      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.classList.contains("active")).toBe(false);
    });

    it("follows store changes", () => {
      const store = new AppStore();
      syncToggleButton(store, "heatmapVisible", "heatmap-btn");
      expect(button.getAttribute("aria-pressed")).toBe("true");

      store.set("heatmapVisible", false);

      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.classList.contains("active")).toBe(false);
    });

    it("stops following after unsubscribe", () => {
      const store = new AppStore();
      const unsubscribe = syncToggleButton(
        store,
        "heatmapVisible",
        "heatmap-btn",
      );

      unsubscribe();
      store.set("heatmapVisible", false);

      expect(button.getAttribute("aria-pressed")).toBe("true");
    });

    it("tolerates a missing button", () => {
      const store = new AppStore();
      expect(() =>
        syncToggleButton(store, "altitudeVisible", "missing-btn"),
      ).not.toThrow();
      expect(() => store.set("altitudeVisible", true)).not.toThrow();
    });
  });

  describe("the look the stylesheet gives the states", () => {
    let style: HTMLStyleElement;

    beforeEach(() => {
      style = document.createElement("style");
      style.textContent = readFileSync("flown/static/styles.css", "utf8");
      document.head.append(style);
    });

    afterEach(() => {
      style.remove();
    });

    /** A control in a row of a column, the way the template has them */
    function control(attributes: string): HTMLElement {
      const row = document.createElement("div");
      row.className = "control-row";
      row.innerHTML = `<button class="btn-surface control-btn" ${attributes}></button>`;
      document.body.append(row);
      return row.firstElementChild as HTMLElement;
    }

    const opacity = (element: HTMLElement): string =>
      getComputedStyle(element).opacity;

    it("draws a toggle at full strength, on or off", () => {
      const off = control('aria-pressed="false"');
      const on = control('aria-pressed="true"');
      applyToggleButtonState(off, false);
      applyToggleButtonState(on, true);

      expect(opacity(off)).toBe("1");
      expect(opacity(on)).toBe("1");
    });

    it("dims a control that cannot act", () => {
      // Replay, Isolate, North up, Reset view and what a replay holds all
      // stay in the tab order (ui/heldControls.ts)
      expect(opacity(control('aria-disabled="true"'))).toBe("0.5");
      expect(opacity(control('aria-disabled="false"'))).toBe("1");
    });
  });

  describe("syncLegend", () => {
    let legend: HTMLElement;

    beforeEach(() => {
      legend = document.createElement("div");
      legend.id = "altitude-legend";
      document.body.appendChild(legend);
    });

    afterEach(() => {
      legend.remove();
    });

    it("shows the legend while its layer is visible and hides it otherwise", () => {
      const store = new AppStore({ altitudeVisible: true });

      syncLegend(store, "altitudeVisible", "altitude-legend");
      expect(legend.hidden).toBe(false);

      store.set("altitudeVisible", false);
      expect(legend.hidden).toBe(true);

      store.set("altitudeVisible", true);
      expect(legend.hidden).toBe(false);
    });

    it("stops following after unsubscribe", () => {
      const store = new AppStore({ altitudeVisible: false });
      const unsubscribe = syncLegend(
        store,
        "altitudeVisible",
        "altitude-legend",
      );

      unsubscribe();
      store.set("altitudeVisible", true);

      expect(legend.hidden).toBe(true);
    });

    it("tolerates a missing legend", () => {
      const store = new AppStore();
      expect(() =>
        syncLegend(store, "airspeedVisible", "missing-legend"),
      ).not.toThrow();
      expect(() => store.set("airspeedVisible", true)).not.toThrow();
    });
  });

  describe("setUnavailable", () => {
    it("says through aria-disabled whether the control can act", () => {
      setUnavailable(button, true);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      // Still in the tab order, to explain itself
      expect(button.disabled).toBe(false);

      setUnavailable(button, false);
      expect(button.getAttribute("aria-disabled")).toBe("false");
    });

    it("keeps a held control unavailable, with its word for the release", () => {
      button.setAttribute("aria-disabled", "true");
      button.dataset["held"] = "true";

      setUnavailable(button, false);

      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.dataset["held"]).toBe("false");
    });

    it("titles the control, or keeps the title for a held one's release", () => {
      setUnavailable(button, true, "Why not");
      expect(button.title).toBe("Why not");

      button.dataset["held"] = "true";
      button.title = "End the tour to change this";
      setUnavailable(button, false, "Replay");

      expect(button.title).toBe("End the tour to change this");
      expect(button.dataset["heldTitle"]).toBe("Replay");
    });
  });

  describe("setControlLabel", () => {
    it("writes into the label span and leaves the icon alone", () => {
      button.innerHTML =
        '<svg class="icon"></svg><span class="control-label">Export image</span>';

      setControlLabel(button, "Exporting…");

      expect(button.querySelector(".control-label")!.textContent).toBe(
        "Exporting…",
      );
      expect(button.querySelector("svg.icon")).not.toBeNull();
    });

    it("creates the missing label span instead of the bare text", () => {
      button.textContent = "Export image";

      setControlLabel(button, "Exporting…");

      expect(button.querySelector(".control-label")!.textContent).toBe(
        "Exporting…",
      );
      expect(button.textContent).toBe("Exporting…");
    });

    it("keeps the icon when it has to create the label span", () => {
      button.innerHTML = '<svg class="icon"></svg>Export image';

      setControlLabel(button, "Exporting…");

      expect(button.querySelector("svg.icon")).not.toBeNull();
      expect(button.textContent).toBe("Exporting…");
      // The icon still precedes the label it belongs to
      expect(button.lastElementChild!.className).toBe("control-label");
    });
  });
});
