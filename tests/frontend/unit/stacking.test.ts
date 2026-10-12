import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The airplane and the popups share one stacking context on the map, and the
 * stylesheets own their order. An airplane above an open airport popup
 * covers it and takes the clicks meant for its buttons. This is the order
 * of the tokens only; that the rules use them, and that nothing between them
 * and the map makes a stacking context of its own, is asked of the page as
 * it is laid out (replay.spec.ts).
 */
function sheet(name: string): string {
  return readFileSync(
    resolve(__dirname, "../../../flown/static", name),
    "utf8",
  );
}

function token(css: string, name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+);`).exec(css);
  expect(match, name).not.toBeNull();
  return Number(match![1]);
}

describe("stacking on the map", () => {
  const styles = sheet("styles.css");

  it("puts a popup above the airplane", () => {
    expect(token(styles, "--z-map-popup")).toBeGreaterThan(
      token(styles, "--z-map-airplane"),
    );
  });

  it("keeps both below the chrome around the map", () => {
    expect(token(styles, "--z-map-popup")).toBeLessThan(
      token(styles, "--z-legend"),
    );
  });
});
