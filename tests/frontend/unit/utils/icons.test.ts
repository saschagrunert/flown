import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  icon,
  iconSizeOf,
  isIconName,
  renderControlIcons,
  setControlIcon,
  DEFAULT_ICON_SIZE,
} from "../../../../flown/frontend/utils/icons";
import { logError } from "../../../../flown/frontend/utils/logger";

vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

describe("icons", () => {
  describe("icon", () => {
    it("draws at the requested size with the matching stroke weight", () => {
      expect(icon("stats", 24)).toContain('width="24"');
      expect(icon("stats", 24)).toContain('stroke-width="1.45"');
      expect(icon("stats", 20)).toContain('stroke-width="1.5"');
      expect(icon("stats", 16)).toContain('stroke-width="1.6"');
    });

    it("hides the icon from assistive tech when it has no title", () => {
      const svg = icon("heatmap");

      expect(svg).toContain('width="20"');
      expect(svg).toContain('aria-hidden="true"');
      expect(svg).toContain('focusable="false"');
      expect(svg).not.toContain("aria-label");
    });

    it("names the icon when a title is given", () => {
      const svg = icon("close", 16, "Close");

      expect(svg).toContain('role="img"');
      expect(svg).toContain('aria-label="Close"');
      expect(svg).not.toContain("aria-hidden");
    });

    it("draws Stop as a filled square, not an empty checkbox", () => {
      // A running replay's control swaps to it (regression)
      expect(icon("stop", 16)).toMatch(/<rect [^>]*fill="currentColor"/);
    });

    it("escapes a title so it cannot break out of the attribute", () => {
      const svg = icon("close", 16, '<b>A & "B"</b>');

      expect(svg).toContain(
        'aria-label="&lt;b&gt;A &amp; &quot;B&quot;&lt;/b&gt;"',
      );
      expect(svg).not.toContain("<b>");
    });
  });

  describe("isIconName", () => {
    it("accepts a known name and rejects anything else", () => {
      expect(isIconName("stats")).toBe(true);
      expect(isIconName("definitely-not-an-icon")).toBe(false);
      expect(isIconName("")).toBe(false);
      expect(isIconName(undefined)).toBe(false);
      // Inherited object members are not icons
      expect(isIconName("toString")).toBe(false);
    });
  });

  describe("iconSizeOf", () => {
    let el: HTMLElement;

    beforeEach(() => {
      el = document.createElement("button");
    });

    it("reads the size the element was last drawn at", () => {
      el.dataset["iconSize"] = "20";

      expect(iconSizeOf(el)).toBe(20);
    });

    it("falls back to the dense row size when unset or off the scale", () => {
      expect(iconSizeOf(el)).toBe(DEFAULT_ICON_SIZE);

      el.dataset["iconSize"] = "17";
      expect(iconSizeOf(el)).toBe(DEFAULT_ICON_SIZE);
    });
  });

  describe("setControlIcon", () => {
    let button: HTMLElement;

    beforeEach(() => {
      vi.mocked(logError).mockClear();
      button = document.createElement("button");
      document.body.appendChild(button);
    });

    afterEach(() => {
      button.remove();
    });

    it("replaces the icon and leaves the label alone", () => {
      button.innerHTML =
        '<svg class="icon" width="16"></svg><span class="control-label">Replay</span>';

      setControlIcon(button, "stop");

      expect(button.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(button.querySelector(".control-label")!.textContent).toBe(
        "Replay",
      );
      expect(button.firstElementChild!.tagName.toLowerCase()).toBe("svg");
      expect(button.dataset["icon"]).toBe("stop");
    });

    it("keeps the size the control was rendered at", () => {
      button.dataset["iconSize"] = "20";

      setControlIcon(button, "play");

      expect(button.querySelector("svg.icon")!.getAttribute("width")).toBe(
        "20",
      );
    });

    it("records an explicit size so a later swap keeps it", () => {
      setControlIcon(button, "play", 24);
      expect(button.dataset["iconSize"]).toBe("24");

      setControlIcon(button, "pause");

      expect(button.querySelector("svg.icon")!.getAttribute("width")).toBe(
        "24",
      );
    });

    it("defaults to the dense row size for an unmarked control", () => {
      setControlIcon(button, "play");

      expect(button.querySelector("svg.icon")!.getAttribute("width")).toBe(
        String(DEFAULT_ICON_SIZE),
      );
    });

    it("logs and draws nothing for an unknown name", () => {
      setControlIcon(button, "not-an-icon" as never);

      expect(button.querySelector("svg.icon")).toBeNull();
      expect(button.dataset["icon"]).toBeUndefined();
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("not-an-icon"),
      );
    });
  });

  describe("renderControlIcons", () => {
    let host: HTMLElement;

    beforeEach(() => {
      vi.mocked(logError).mockClear();
      host = document.createElement("div");
      document.body.appendChild(host);
    });

    afterEach(() => {
      host.remove();
    });

    it("draws the icon of every [data-icon] element at the row size", () => {
      host.innerHTML =
        '<button data-icon="stats"><span class="control-label">Statistics</span></button>' +
        '<button data-icon="heatmap"></button>';

      renderControlIcons(host);

      const icons = host.querySelectorAll("svg.icon");
      expect(icons).toHaveLength(2);
      expect(icons[0]!.getAttribute("width")).toBe("16");
      expect(icons[0]!.getAttribute("aria-hidden")).toBe("true");
      // The icon precedes the label it belongs to
      expect(host.querySelector("button")!.firstElementChild).toBe(icons[0]);
    });

    it("honours a per-element size and overrides it with an explicit one", () => {
      host.innerHTML =
        '<button data-icon="close" data-icon-size="20"></button>' +
        '<button data-icon="stats"></button>';

      renderControlIcons(host);
      expect(host.querySelectorAll("svg.icon")[0]!.getAttribute("width")).toBe(
        "20",
      );

      renderControlIcons(host, 24);
      const widths = Array.from(host.querySelectorAll("svg.icon")).map((el) =>
        el.getAttribute("width"),
      );
      expect(widths).toEqual(["24", "24"]);
    });

    it("replaces the icon instead of adding a second one", () => {
      host.innerHTML =
        '<button data-icon="stats"><span class="control-label">Statistics</span></button>';

      renderControlIcons(host);
      renderControlIcons(host, 20);

      expect(host.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(host.querySelector("svg.icon")!.getAttribute("width")).toBe("20");
      expect(host.querySelector(".control-label")!.textContent).toBe(
        "Statistics",
      );
    });

    it("falls back to the row size for an unknown size and skips empty names", () => {
      host.innerHTML =
        '<button data-icon="stats" data-icon-size="17"></button>' +
        '<button data-icon=""></button>';

      renderControlIcons(host);

      const icons = host.querySelectorAll("svg.icon");
      expect(icons).toHaveLength(1);
      expect(icons[0]!.getAttribute("width")).toBe("16");
    });

    it("logs and skips an unknown icon name instead of drawing nothing", () => {
      host.innerHTML =
        '<button id="typo-btn" data-icon="definitely-not-an-icon"></button>' +
        '<button data-icon="stats"></button>';

      renderControlIcons(host);

      expect(host.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(host.querySelector("#typo-btn")!.innerHTML).toBe("");
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("definitely-not-an-icon"),
      );
    });

    it("walks the whole document by default", () => {
      host.innerHTML = '<button data-icon="stats"></button>';

      renderControlIcons();

      expect(host.querySelector("svg.icon")).not.toBeNull();
    });

    it("keeps a later icon swap at the size the column was drawn at", () => {
      host.innerHTML =
        '<button id="replay-btn" data-icon="play"></button>' +
        '<button data-icon="stats"></button>';

      // The compact column redraws every icon at the larger size
      renderControlIcons(host, 20);
      const replayBtn = host.querySelector<HTMLElement>("#replay-btn")!;
      expect(replayBtn.dataset["iconSize"]).toBe("20");

      // A replay toggle swaps that one icon without naming a size
      setControlIcon(replayBtn, "stop");

      expect(replayBtn.querySelector("svg.icon")!.getAttribute("width")).toBe(
        "20",
      );
    });
  });
});
