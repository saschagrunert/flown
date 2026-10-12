/**
 * The landmarks and headings of the page (map_template.html), which a
 * screen reader moves by: the page had none, and no h1 either
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_TIMING_MESSAGE } from "../../../flown/frontend/ui/actions";

const page = new DOMParser().parseFromString(
  readFileSync(
    join(__dirname, "../../../flown/templates/map_template.html"),
    "utf8",
  ),
  "text/html",
);

describe("the landmarks of the page", () => {
  it("has one main, around the map and what is said over it", () => {
    const mains = page.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]!.getAttribute("role")).toBe("main");
    for (const id of ["map", "selection-chip", "map-empty", "loading"]) {
      expect(mains[0]!.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it("has the map as a region, so its popups read as a page does", () => {
    // An application role takes the screen reader out of browse mode, and
    // the popups of airports and segments are text with links
    const map = page.getElementById("map")!;
    expect(map.getAttribute("role")).toBe("region");
    expect(map.getAttribute("aria-label")).toBe("Flight map");
  });

  it("keeps the toasts out of main, which Wrapped makes inert, the stack ahead of it", () => {
    const main = page.querySelector("main")!;
    for (const id of ["toast-stack", "toast-status", "toast-alert"]) {
      expect(page.getElementById(id)!.parentElement, id).toBe(page.body);
    }
    expect(page.getElementById("toast-stack")!.nextElementSibling).toBe(main);
  });

  it("names its one h1 in a header, ahead of everything but the skip link", () => {
    // Wrapped's dialog has an h1 of its own
    const headings = [...page.querySelectorAll("h1")].filter(
      (heading) => !heading.closest("#wrapped-modal"),
    );
    expect(headings).toHaveLength(1);
    expect(headings[0]!.closest("header")).not.toBeNull();
    expect(page.querySelector("header")!.previousElementSibling).toBe(
      page.querySelector(".skip-nav"),
    );
  });

  it("names each control column, each differently", () => {
    const columns = [...page.querySelectorAll("nav.control-column")];
    const names = columns.map((column) => column.getAttribute("aria-label"));

    expect(columns.map((column) => column.id)).toEqual([
      "left-buttons",
      "right-buttons",
    ]);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names the statistics rail by its title, and has the credit in a footer", () => {
    const rail = page.getElementById("stats-rail")!;
    expect(rail.localName).toBe("aside");
    expect(page.getElementById(rail.getAttribute("aria-labelledby")!)).toBe(
      page.getElementById("stats-rail-title"),
    );
    expect(page.getElementById("github-footer")!.localName).toBe("footer");
  });
});

describe("Groundspeed before the metadata says there are speeds", () => {
  it("is unavailable and reachable, with the words its click says", () => {
    const button = page.getElementById("airspeed-btn") as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(page.getElementById("airspeed-reason")!.textContent).toBe(
      NO_TIMING_MESSAGE,
    );
  });
});
