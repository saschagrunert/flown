/**
 * The table of toggles, and what it has to agree with: the links shared so
 * far (see urlState.test.ts), the buttons of the page template and the
 * actions the app runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initialToggles,
  TOGGLE_KEYS,
  TOGGLES,
  VISIBILITY_SLOTS,
  type ToggleUrl,
} from "../../../../flown/frontend/state/toggles";
import {
  runAction,
  type ActionName,
} from "../../../../flown/frontend/ui/actions";
import { asMapApp, createMockApp } from "../../testHelpers";

const TEMPLATE = readFileSync(
  join(__dirname, "../../../../flown/templates/map_template.html"),
  "utf8",
);

function templateDocument(): Document {
  return new DOMParser().parseFromString(TEMPLATE, "text/html");
}

describe("toggles", () => {
  it("gives every toggle a place of its own in a link", () => {
    const urls: ToggleUrl[] = TOGGLES.map((toggle) => toggle.url);
    const slots = urls.flatMap((url) => ("slot" in url ? [url.slot] : []));
    const params = urls.flatMap((url) => ("param" in url ? [url.param] : []));

    expect(new Set(slots).size).toBe(slots.length);
    expect(new Set(params).size).toBe(params.length);
    // Slot 7 is retired, and the string keeps its nine characters
    expect([...slots, 7].sort()).toEqual(
      Array.from({ length: VISIBILITY_SLOTS }, (_, i) => i),
    );
    // None of the parameters is taken by the rest of the link
    for (const taken of [
      "y",
      "a",
      "p",
      "sv",
      "v",
      "lat",
      "lng",
      "z",
      "b",
      "t",
    ]) {
      expect(params).not.toContain(taken);
    }
  });

  it("lists every key once", () => {
    expect(new Set(TOGGLE_KEYS).size).toBe(TOGGLES.length);
    expect(Object.keys(initialToggles())).toEqual([...TOGGLE_KEYS]);
  });

  it("opens with the heatmap and the airports, and nothing else", () => {
    expect(
      TOGGLES.filter((toggle) => toggle.initial).map((toggle) => toggle.key),
    ).toEqual(["heatmapVisible", "airportsVisible"]);
  });

  describe("the page template", () => {
    for (const toggle of TOGGLES) {
      if (!("button" in toggle)) continue;
      it(`has the button of ${toggle.key}`, () => {
        const button = templateDocument().getElementById(toggle.button);

        expect(button, toggle.button).not.toBeNull();
        expect(button!.dataset["action"]).toBe(toggle.action);
        expect(button!.dataset["icon"]).toBe(toggle.icon);
        expect(button!.querySelector(".control-label")?.textContent).toBe(
          toggle.label,
        );
      });
    }

    it("marks the pressed state of every button that shows its key", () => {
      const doc = templateDocument();
      for (const toggle of TOGGLES) {
        if (!("pressed" in toggle)) continue;
        expect(
          doc.getElementById(toggle.button)!.hasAttribute("aria-pressed"),
          toggle.button,
        ).toBe(true);
      }
    });

    it("names only actions the app has", () => {
      const doc = templateDocument();
      const names = new Set(
        Array.from(
          doc.querySelectorAll<HTMLElement>("[data-action]"),
          (element) => element.dataset["action"]!,
        ),
      );
      const app = createMockApp();
      // The replay slider reads its value off the event's target
      const event = { target: { value: "0" } } as unknown as Event;

      for (const name of names) {
        expect(runAction(asMapApp(app), name as ActionName, event), name).toBe(
          true,
        );
      }
    });
  });
});
