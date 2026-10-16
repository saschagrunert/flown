/**
 * MobileSheet: rendering, the three row kinds, dismissal and focus handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Mock } from "vitest";
import {
  MobileSheet,
  type SheetRow,
} from "../../../../flown/frontend/ui/mobileSheet";

function rows(sheet: MobileSheet): HTMLElement[] {
  return Array.from(sheet.root.querySelectorAll<HTMLElement>(".sheet-row"));
}

function row(sheet: MobileSheet, id: string): HTMLElement {
  const element = sheet.root.querySelector<HTMLElement>(`[data-row="${id}"]`);
  if (!element) throw new Error(`Missing sheet row ${id}`);
  return element;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

/**
 * A touch pointer event at `clientY`, `time` ms into the gesture. jsdom
 * stamps events with the real clock, so the stamp is set on the event.
 */
function touch(
  target: Element,
  type: string,
  clientY: number,
  time: number,
  options: PointerEventInit = {},
): void {
  const event = new PointerEvent(type, {
    clientY,
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  Object.defineProperty(event, "timeStamp", { value: time });
  target.dispatchEvent(event);
}

describe("MobileSheet", () => {
  let sheet: MobileSheet;

  beforeEach(() => {
    sheet = new MobileSheet("test-sheet");
    sheet.mount(document.body);
  });

  afterEach(() => {
    sheet.destroy();
    document.body.replaceChildren();
  });

  describe("mounting", () => {
    it("adds a hidden scrim and sheet", () => {
      expect(document.getElementById("test-sheet")).toBe(sheet.root);
      expect(document.getElementById("test-sheet-scrim")).toBe(sheet.scrim);
      expect(sheet.root.hidden).toBe(true);
      expect(sheet.scrim.hidden).toBe(true);
      expect(sheet.isOpen()).toBe(false);
      expect(sheet.root.hasAttribute("inert")).toBe(true);
    });

    it("is a labelled modal dialog", () => {
      expect(sheet.root.getAttribute("role")).toBe("dialog");
      expect(sheet.root.getAttribute("aria-modal")).toBe("true");
      expect(sheet.root.getAttribute("aria-labelledby")).toBe(
        "test-sheet-title",
      );
      // The close control must stay outside the labelling element
      expect(
        document.getElementById("test-sheet-title")!.querySelector("button"),
      ).toBeNull();
    });
  });

  describe("openWith", () => {
    it("shows the title, the rows and the scrim", () => {
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "heatmap",
          icon: "heatmap",
          label: "Heatmap",
          isOn: () => true,
          onToggle: vi.fn(),
        },
      ]);

      expect(sheet.isOpen()).toBe(true);
      expect(sheet.root.hidden).toBe(false);
      expect(sheet.scrim.hidden).toBe(false);
      // The stylesheet slides the sheet in on .is-open
      expect(sheet.root.classList.contains("is-open")).toBe(true);
      expect(sheet.scrim.classList.contains("is-open")).toBe(true);
      expect(sheet.root.querySelector(".sheet-title-text")!.textContent).toBe(
        "Layers",
      );
      expect(rows(sheet)).toHaveLength(1);
    });

    it("moves focus into the sheet and returns it on close", () => {
      const opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();

      sheet.openWith("Layers", []);
      expect(document.activeElement).toBe(sheet.root);

      sheet.close();
      expect(document.activeElement).toBe(opener);
    });

    it("returns focus to the tab that swapped the sheet, not the first opener", () => {
      const first = document.createElement("button");
      const second = document.createElement("button");
      document.body.append(first, second);
      first.focus();
      sheet.openWith("Layers", []);

      // The tabs stay reachable while the sheet is open
      second.focus();
      sheet.openWith("Filter", []);
      sheet.close();

      expect(document.activeElement).toBe(second);
    });

    it("keeps the first opener when the swap left focus inside the sheet", () => {
      const first = document.createElement("button");
      document.body.append(first);
      first.focus();
      sheet.openWith("Layers", []);
      expect(document.activeElement).toBe(sheet.root);

      sheet.openWith("Filter", []);
      sheet.close();

      expect(document.activeElement).toBe(first);
    });

    it("replaces the rows of a previous open", () => {
      const spec = (id: string): SheetRow => ({
        kind: "action",
        id,
        icon: "stats",
        label: id,
        onSelect: vi.fn(),
      });

      sheet.openWith("First", [spec("a"), spec("b")]);
      sheet.close();
      sheet.openWith("Second", [spec("c")]);

      expect(rows(sheet)).toHaveLength(1);
      expect(row(sheet, "c")).not.toBeNull();
    });

    it("runs the close callback once", () => {
      const onClose = vi.fn();
      sheet.openWith("Layers", [], onClose);

      sheet.close();
      sheet.close();

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("dismissal", () => {
    beforeEach(() => {
      sheet.openWith("Layers", []);
    });

    it("closes on a scrim tap", () => {
      sheet.scrim.click();

      expect(sheet.isOpen()).toBe(false);
      expect(sheet.root.hidden).toBe(true);
      expect(sheet.root.classList.contains("is-open")).toBe(false);
    });

    it("closes on the close control", () => {
      sheet.root.querySelector<HTMLButtonElement>(".sheet-close")!.click();

      expect(sheet.isOpen()).toBe(false);
    });

    it("closes on Escape", () => {
      pressEscape();

      expect(sheet.isOpen()).toBe(false);
    });

    it("leaves an Escape that something else took first", () => {
      // The readout of the cloud closed, and the sheet under it with it
      const taken = (event: Event): void => event.preventDefault();
      document.addEventListener("keydown", taken, true);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
      document.removeEventListener("keydown", taken, true);

      expect(sheet.isOpen()).toBe(true);
    });

    it("stops taking taps the moment it closes", () => {
      // `hidden` alone leaves the sheet hit-testable: the stylesheet gives
      // `.mobile-sheet` a display of its own, and the slide-out delays
      // `visibility` by the whole transition, so a tap landing where a row
      // used to be still fired that row
      sheet.root.querySelector<HTMLButtonElement>(".sheet-close")!.click();

      expect(sheet.root.hasAttribute("inert")).toBe(true);
      expect(sheet.root.style.pointerEvents).toBe("none");
    });

    it("becomes interactive again on the next open", () => {
      sheet.close();
      expect(sheet.root.hasAttribute("inert")).toBe(true);

      sheet.openWith("Filter", []);

      expect(sheet.root.hasAttribute("inert")).toBe(false);
      expect(sheet.root.style.pointerEvents).toBe("");
    });

    it("ignores Escape once closed", () => {
      const onClose = vi.fn();
      sheet.openWith("Layers", [], onClose);
      sheet.close();
      onClose.mockClear();

      pressEscape();

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("dragging the top edge", () => {
    /** The sheet's height; a drag past a third of it closes it */
    const HEIGHT = 300;

    let title: HTMLElement;
    let onClose: Mock<() => void>;
    let toggle: Mock<() => void>;
    let capture: Mock<(pointerId: number) => void>;
    let opener: HTMLButtonElement;

    beforeEach(() => {
      opener = document.createElement("button");
      document.body.append(opener);
      opener.focus();
      onClose = vi.fn();
      toggle = vi.fn();
      sheet.openWith(
        "Layers",
        [
          {
            kind: "switch",
            id: "heatmap",
            icon: "heatmap",
            label: "Heatmap",
            isOn: () => false,
            onToggle: toggle,
          },
        ],
        onClose,
      );
      title = sheet.root.querySelector<HTMLElement>(".sheet-title")!;
      // jsdom lays nothing out and has no pointer capture
      Object.defineProperty(sheet.root, "offsetHeight", { value: HEIGHT });
      capture = vi.fn();
      title.setPointerCapture = capture;
    });

    /** A drag from y 100 by `by` px over `ms`, lifted `rest` ms later */
    function drag(by: number, ms: number, rest = 0, end = "pointerup"): void {
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointermove", 100 + by / 2, ms / 2);
      touch(title, "pointermove", 100 + by, ms);
      touch(title, end, 100 + by, ms + rest);
    }

    it("moves the sheet with the finger, with the transition off", () => {
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointermove", 160, 300);

      expect(capture).toHaveBeenCalledWith(1);
      expect(sheet.root.style.transform).toBe("translateY(60px)");
      expect(sheet.root.style.transition).toBe("none");
    });

    it("closes through close() once let go past a third of its height", () => {
      drag(HEIGHT / 3 + 10, 600);

      expect(sheet.isOpen()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(sheet.root.hidden).toBe(true);
      expect(sheet.root.hasAttribute("inert")).toBe(true);
      expect(document.activeElement).toBe(opener);
      // The stylesheet's transition takes it the rest of the way down
      expect(sheet.root.style.transform).toBe("");
      expect(sheet.root.style.transition).toBe("");
    });

    it("springs back when let go short of it", () => {
      drag(HEIGHT / 3 - 10, 600);

      expect(sheet.isOpen()).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(sheet.root.style.transform).toBe("");
      expect(sheet.root.style.transition).toBe("");
    });

    it("closes on a short fast flick", () => {
      // 40 px in 40 ms, lifted at once
      drag(40, 40, 8);

      expect(sheet.isOpen()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("takes neither a fast move that rested nor a jitter for a flick", () => {
      drag(40, 40, 200);
      expect(sheet.isOpen()).toBe(true);

      // A tap's few pixels, however fast
      drag(6, 4, 0);
      expect(sheet.isOpen()).toBe(true);
    });

    it("ignores a drag upwards", () => {
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointermove", 20, 40);

      expect(sheet.root.style.transform).toBe("translateY(0px)");

      touch(title, "pointerup", 20, 40);
      expect(sheet.isOpen()).toBe(true);
      expect(sheet.root.style.transform).toBe("");
    });

    it("springs back when the browser takes the pointer over", () => {
      drag(HEIGHT, 600, 0, "pointercancel");

      expect(sheet.isOpen()).toBe(true);
      expect(sheet.root.style.transform).toBe("");
    });

    it("hands the release to the stylesheet, which does not animate under reduced motion", () => {
      // The sheet does not ask for reduced motion itself: the spring back
      // and the slide out are the stylesheet's transition, which the
      // reduced motion rule turns off
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointermove", 150, 300);
      touch(title, "pointerup", 150, 300);

      // No transition of its own is left inline, so the reduced motion
      // rule decides: the sheet is back at once
      expect(sheet.root.style.transition).toBe("");
      expect(sheet.root.style.transform).toBe("");

      const style = document.createElement("style");
      style.textContent = readFileSync(
        resolve(__dirname, "../../../../flown/static/extras.css"),
        "utf8",
      );
      document.head.append(style);
      const reduced = [...style.sheet!.cssRules]
        .filter(
          (rule): rule is CSSMediaRule =>
            rule instanceof CSSMediaRule &&
            rule.media.mediaText === "(prefers-reduced-motion: reduce)",
        )
        .flatMap((rule) => [...rule.cssRules])
        .filter(
          (rule): rule is CSSStyleRule =>
            rule instanceof CSSStyleRule &&
            rule.selectorText
              .split(",")
              .some((one) => one.trim() === ".mobile-sheet"),
        );
      style.remove();
      expect(reduced.map((rule) => rule.style.transition)).toContain("none");
    });

    it("does nothing for a drag that starts on a row, whose tap still toggles", () => {
      const heatmap = row(sheet, "heatmap");
      touch(heatmap, "pointerdown", 200, 0);
      touch(heatmap, "pointermove", 400, 300);
      touch(heatmap, "pointerup", 400, 300);

      expect(capture).not.toHaveBeenCalled();
      expect(sheet.root.style.transform).toBe("");
      expect(sheet.isOpen()).toBe(true);

      heatmap.click();
      expect(toggle).toHaveBeenCalledTimes(1);
    });

    it("leaves the close button its click", () => {
      const close = sheet.root.querySelector<HTMLElement>(".sheet-close")!;
      touch(close, "pointerdown", 100, 0, { pointerType: "mouse" });

      // Captured by the row, the click would go to the row instead
      expect(capture).not.toHaveBeenCalled();

      close.click();
      expect(sheet.isOpen()).toBe(false);
    });

    it("ignores a secondary button and a second finger", () => {
      touch(title, "pointerdown", 100, 0, { button: 2, pointerType: "mouse" });
      touch(title, "pointerdown", 100, 0, { isPrimary: false, pointerId: 2 });

      expect(capture).not.toHaveBeenCalled();
    });

    it("drops a drag in progress when the sheet closes otherwise", () => {
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointermove", 150, 300);

      pressEscape();

      expect(sheet.isOpen()).toBe(false);
      expect(sheet.root.style.transform).toBe("");
      expect(sheet.root.style.transition).toBe("");

      // The finger that is still down moves nothing, and a sheet opened
      // under it again starts where the stylesheet puts it
      touch(title, "pointermove", 250, 400);
      sheet.openWith("Filter", []);
      touch(title, "pointermove", 300, 500);
      touch(title, "pointerup", 300, 500);
      expect(sheet.isOpen()).toBe(true);
      expect(sheet.root.style.transform).toBe("");
    });

    it("drops a drag in progress when another tab swaps the sheet", () => {
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointermove", 150, 300);

      sheet.openWith("Filter", []);

      expect(sheet.root.style.transform).toBe("");
      expect(sheet.root.style.transition).toBe("");
      touch(title, "pointerup", 250, 300);
      expect(sheet.isOpen()).toBe(true);
    });

    it("does nothing for a tap on the title", () => {
      touch(title, "pointerdown", 100, 0);
      touch(title, "pointerup", 100, 80);

      expect(sheet.isOpen()).toBe(true);
      expect(onClose).not.toHaveBeenCalled();
      expect(sheet.root.style.transform).toBe("");
    });
  });

  describe("switch rows", () => {
    let on: boolean;
    let toggle: Mock<() => void>;

    beforeEach(() => {
      on = false;
      toggle = vi.fn(() => {
        on = !on;
      });
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "altitude",
          icon: "altitude",
          label: "Altitude",
          chip: "altitude",
          isOn: () => on,
          onToggle: toggle,
        },
      ]);
    });

    it("renders a switch with a 24px icon and a gradient chip", () => {
      const element = row(sheet, "altitude");

      expect(element.getAttribute("role")).toBe("switch");
      expect(element.getAttribute("aria-checked")).toBe("false");
      expect(
        element.querySelector(":scope > svg.icon")!.getAttribute("width"),
      ).toBe("24");
      expect(element.querySelector(".gradient-chip-altitude")).not.toBeNull();
      expect(element.querySelector(".sheet-switch")).not.toBeNull();
    });

    it("toggles and reflects the new state", () => {
      row(sheet, "altitude").click();

      expect(toggle).toHaveBeenCalledTimes(1);
      expect(row(sheet, "altitude").getAttribute("aria-checked")).toBe("true");
      expect(row(sheet, "altitude").classList.contains("active")).toBe(true);
    });

    it("marks a row whose control is unavailable, and ignores a tap on it", () => {
      const onToggle = vi.fn();
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "speed",
          icon: "speed",
          label: "Speed",
          isOn: () => false,
          isDisabled: () => true,
          onToggle,
        },
      ]);
      const speed = row(sheet, "speed") as HTMLButtonElement;

      // Announced as unavailable and still reachable by keyboard, like an
      // action row and like the desktop controls
      expect(speed.getAttribute("aria-disabled")).toBe("true");
      expect(speed.disabled).toBe(false);
      speed.click();
      expect(onToggle).not.toHaveBeenCalled();
      expect(speed.getAttribute("aria-checked")).toBe("false");
    });
  });

  describe("select rows", () => {
    let source: HTMLSelectElement;

    beforeEach(() => {
      source = document.createElement("select");
      source.id = "year-select";
      // Matches what the app writes: appInitializer and filterManager
      // stopped prefixing option labels with an emoji
      for (const [value, label] of [
        ["all", "All years"],
        ["2024", "2024"],
        ["2025", "2025"],
      ]) {
        const option = document.createElement("option");
        option.value = value!;
        option.textContent = label!;
        source.append(option);
      }
      source.value = "2025";
      document.body.append(source);

      sheet.openWith("Filter", [
        {
          kind: "select",
          id: "year",
          icon: "calendar",
          label: "Year",
          sourceId: "year-select",
        },
      ]);
    });

    it("mirrors the options and shows the value", () => {
      const select = row(sheet, "year").querySelector("select")!;

      // The unfiltered option is relabelled: the row already says "Year"
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        "All",
        "2024",
        "2025",
      ]);
      expect(select.value).toBe("2025");
      expect(
        row(sheet, "year").querySelector(".sheet-row-value")!.textContent,
      ).toBe("2025");
      expect(
        row(sheet, "year").querySelector(".sheet-row-chevron"),
      ).not.toBeNull();
    });

    it("writes the choice back to the page's own dropdown", () => {
      const changed = vi.fn();
      source.addEventListener("change", changed);
      const select = row(sheet, "year").querySelector("select")!;

      select.value = "2024";
      select.dispatchEvent(new Event("change"));

      expect(source.value).toBe("2024");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(
        row(sheet, "year").querySelector(".sheet-row-value")!.textContent,
      ).toBe("2024");
    });

    it("reads the page's dropdown back even when the choice matches it", () => {
      const select = row(sheet, "year").querySelector("select")!;
      select.value = "2024";
      select.dispatchEvent(new Event("change"));
      // The page put its dropdown back (the year failed to load) without
      // an event; the row still says 2024
      source.value = "2025";
      const changed = vi.fn();
      source.addEventListener("change", changed);

      select.value = "2025";
      select.dispatchEvent(new Event("change"));

      expect(changed).not.toHaveBeenCalled();
      expect(
        row(sheet, "year").querySelector(".sheet-row-value")!.textContent,
      ).toBe("2025");
    });

    it("follows the source when it is disabled during replay", () => {
      source.disabled = true;

      sheet.refresh();

      expect(row(sheet, "year").querySelector("select")!.disabled).toBe(true);
    });

    it("disables itself when the source is missing", () => {
      source.remove();

      sheet.refresh();

      expect(row(sheet, "year").querySelector("select")!.disabled).toBe(true);
    });
  });

  describe("action rows", () => {
    it("closes the sheet before running the action", () => {
      const order: string[] = [];
      sheet.openWith(
        "More",
        [
          {
            kind: "action",
            id: "export",
            icon: "export",
            label: "Export map",
            onSelect: () => order.push("action"),
          },
        ],
        () => order.push("close"),
      );

      row(sheet, "export").click();

      expect(order).toEqual(["close", "action"]);
      expect(sheet.isOpen()).toBe(false);
    });

    it("keeps the sheet open when the row asks for it", () => {
      const onSelect = vi.fn();
      sheet.openWith("More", [
        {
          kind: "action",
          id: "keep",
          icon: "stats",
          label: "Keep open",
          closeOnSelect: false,
          onSelect,
        },
      ]);

      row(sheet, "keep").click();

      expect(onSelect).toHaveBeenCalled();
      expect(sheet.isOpen()).toBe(true);
    });

    it("shows and hides the hint line", () => {
      let ready = false;
      sheet.openWith("More", [
        {
          kind: "action",
          id: "replay",
          icon: "play",
          label: "Replay flight",
          hint: () => (ready ? null : "Select one flight"),
          onSelect: vi.fn(),
        },
      ]);

      const hint = row(sheet, "replay").querySelector<HTMLElement>(
        ".sheet-row-hint",
      )!;
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe("Select one flight");

      ready = true;
      sheet.refresh();

      expect(hint.hidden).toBe(true);
    });

    it("names a row by its label, and describes it by its hint", () => {
      sheet.openWith("Layers", [
        {
          kind: "switch",
          id: "speed",
          icon: "speed",
          label: "Groundspeed",
          isOn: () => false,
          isDisabled: () => true,
          hint: () => "No timing data in the flights",
          onToggle: vi.fn(),
        },
      ]);

      const element = row(sheet, "speed");
      const label = element.querySelector(".sheet-row-label")!;
      const hint = element.querySelector(".sheet-row-hint")!;
      // From its contents its name ran the two together
      expect(element.getAttribute("aria-labelledby")).toBe(label.id);
      expect(element.getAttribute("aria-describedby")).toBe(hint.id);
      expect(hint.textContent).toBe("No timing data in the flights");
    });
  });

  describe("focus trap", () => {
    beforeEach(() => {
      sheet.openWith("More", [
        {
          kind: "action",
          id: "one",
          icon: "stats",
          label: "One",
          onSelect: vi.fn(),
        },
      ]);
    });

    it("wraps from the last control to the first", () => {
      const focusable = sheet.root.querySelectorAll<HTMLElement>("button");
      const last = focusable[focusable.length - 1]!;
      last.focus();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

      expect(document.activeElement).toBe(focusable[0]);
    });

    it("wraps backwards from the sheet itself to the last control", () => {
      const focusable = sheet.root.querySelectorAll<HTMLElement>("button");

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }),
      );

      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    });

    it("keeps focus on the sheet when it holds no controls", () => {
      sheet.close();
      sheet.root.querySelector(".sheet-close")!.remove();
      sheet.openWith("Empty", []);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

      expect(document.activeElement).toBe(sheet.root);
    });
  });
});
