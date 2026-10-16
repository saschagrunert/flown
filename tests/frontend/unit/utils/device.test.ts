/**
 * The questions the app asks about the device: the phone layout, a finger
 * for a pointer, and a pointer that cannot hover.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  PHONE_LAYOUT_QUERY,
  isPhoneLayout,
  isSmallDevice,
  isTouchDevice,
  followPhoneLayout,
  matchesMedia,
  shareLinkLabel,
  TouchClock,
} from "../../../../flown/frontend/utils/device";
import { MOBILE_BREAKPOINT_PX } from "../../../../flown/frontend/utils/constants";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Answer the media queries of `matching` as matched, every other not */
function stubMedia(...matching: string[]): ReturnType<typeof vi.fn> {
  const matchMedia = vi.fn((query: string) => ({
    matches: matching.includes(query),
  }));
  Object.defineProperty(window, "matchMedia", {
    value: matchMedia,
    configurable: true,
    writable: true,
  });
  return matchMedia;
}

function setInnerWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
}

describe("device", () => {
  const innerWidth = window.innerWidth;

  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
    Reflect.deleteProperty(window, "ontouchstart");
    setInnerWidth(innerWidth);
  });

  describe("the phone layout", () => {
    it("is the stylesheet's breakpoint, just under it", () => {
      expect(PHONE_LAYOUT_QUERY).toBe(
        "(max-width: 767.98px), (max-height: 480px)",
      );
    });

    it("is the one the stylesheets give the phone, and leave the columns", () => {
      // A phone held sideways (844 by 390) is wide enough for the columns
      // but too short for them: every width rule says so too
      for (const name of ["styles", "features", "wrapped", "extras"]) {
        const css = readFileSync(
          resolve(__dirname, `../../../../flown/static/${name}.css`),
          "utf8",
        );
        for (const [, query] of css.matchAll(/@media ([^{]*width[^{]*)\{/g)) {
          const min = /\(min-width: (\d+)px\)/.exec(query!);
          const max = /^\(max-width: (\d+)\.98px\)/.exec(query!.trim());
          if (min && Number(min[1]) >= MOBILE_BREAKPOINT_PX) {
            expect(query, name).toContain("and (min-height: 480.02px)");
          } else if (max && Number(max[1]) >= MOBILE_BREAKPOINT_PX - 1) {
            expect(query, name).toContain(", (max-height: 480px)");
          }
        }
      }
    });

    it("is a short window's too, without media queries", () => {
      Reflect.deleteProperty(window, "matchMedia");
      setInnerWidth(844);
      const height = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        value: 390,
        configurable: true,
      });

      expect(isPhoneLayout()).toBe(true);
      Object.defineProperty(window, "innerHeight", {
        value: height,
        configurable: true,
      });
      expect(isPhoneLayout()).toBe(false);
    });

    it("follows the media query where there is one", () => {
      setInnerWidth(1280);
      const matchMedia = stubMedia(PHONE_LAYOUT_QUERY);

      expect(isPhoneLayout()).toBe(true);
      expect(matchMedia).toHaveBeenCalledWith(PHONE_LAYOUT_QUERY);

      stubMedia();
      setInnerWidth(390);
      expect(isPhoneLayout()).toBe(false);
    });

    it("goes by the width of the window without media queries", () => {
      setInnerWidth(MOBILE_BREAKPOINT_PX - 1);
      expect(isPhoneLayout()).toBe(true);
      setInnerWidth(MOBILE_BREAKPOINT_PX);
      expect(isPhoneLayout()).toBe(false);
    });
  });

  describe("isSmallDevice", () => {
    it("is true in the phone layout", () => {
      stubMedia(PHONE_LAYOUT_QUERY);
      expect(isSmallDevice()).toBe(true);
    });

    it("is true for coarse pointers on wide viewports", () => {
      stubMedia("(pointer: coarse)");
      expect(isSmallDevice()).toBe(true);
    });

    it("is false for wide viewports with a fine pointer", () => {
      stubMedia();
      expect(isSmallDevice()).toBe(false);
    });
  });

  describe("isTouchDevice", () => {
    it("returns false when no touch support", () => {
      expect(isTouchDevice()).toBe(false);
    });

    it("asks the hover media query when the browser has one", () => {
      // A laptop with a touchscreen is driven by its mouse most of the
      // time; touch support alone lost it the hover tooltips
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      stubMedia();
      expect(isTouchDevice()).toBe(false);
      stubMedia("(hover: none)");
      expect(isTouchDevice()).toBe(true);
    });

    it("returns true when ontouchstart exists", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      expect(isTouchDevice()).toBe(true);
    });

    it("returns true when maxTouchPoints > 0", () => {
      const original = navigator.maxTouchPoints;
      Object.defineProperty(navigator, "maxTouchPoints", {
        value: 1,
        configurable: true,
      });
      try {
        expect(isTouchDevice()).toBe(true);
      } finally {
        Object.defineProperty(navigator, "maxTouchPoints", {
          value: original,
          configurable: true,
        });
      }
    });
  });

  describe("matchesMedia", () => {
    it("is false without media queries", () => {
      expect(matchesMedia("(prefers-contrast: more)")).toBe(false);
    });

    it("asks the browser where it can", () => {
      stubMedia("(prefers-contrast: more)");
      expect(matchesMedia("(prefers-contrast: more)")).toBe(true);
      expect(matchesMedia("(hover: none)")).toBe(false);
    });
  });

  describe("the touch clock", () => {
    const at = (timeStamp: number, pointerType?: string): Event =>
      ({ timeStamp, pointerType }) as unknown as Event;

    it("takes a click's own word for its pointer", () => {
      const clock = new TouchClock();
      stubMedia("(hover: none)");

      expect(clock.isTouchClick(at(100, "touch"))).toBe(true);
      expect(clock.isTouchClick(at(100, "mouse"))).toBe(false);
    });

    it("takes a click a touch came just before for a tap, whatever it says", () => {
      // WebKit's click for a tap says nothing of its pointer, or "mouse",
      // on a page that can hover
      const clock = new TouchClock();
      stubMedia();
      clock.note(at(1000));

      expect(clock.isTouchClick(at(1100))).toBe(true);
      expect(clock.isTouchClick(at(1100, "mouse"))).toBe(true);
      // A mouse's click a while later, or long before
      expect(clock.isTouchClick(at(2500))).toBe(false);
      expect(clock.isTouchClick(at(-100))).toBe(false);
      expect(clock.follows(at(1500))).toBe(true);
      expect(clock.follows(at(2500))).toBe(false);
    });

    it("takes a click stamped at or just before the end of the touch for a tap", () => {
      // Handled after the touch, so the browser's for it, whatever its
      // stamp says: WebKit may stamp it with the end of the touch or a
      // moment before, which then counted as a mouse's
      const clock = new TouchClock();
      stubMedia();
      clock.note(at(1000));
      clock.note(at(1800));

      expect(clock.isTouchClick(at(1800, "mouse"))).toBe(true);
      expect(clock.isTouchClick(at(1790, "mouse"))).toBe(true);
      expect(clock.isTouchClick(at(1810, "mouse"))).toBe(true);
      expect(clock.isTouchClick(at(700, "mouse"))).toBe(false);
    });

    it("measures from the end of a touch, for a long press or a busy page", () => {
      // iOS says "mouse" for a tap's click. A press of a second and more
      // was over long after it began, and its click came after the end.
      const clock = new TouchClock();
      stubMedia();
      clock.note(at(1000));
      clock.note(at(2400));

      expect(clock.isTouchClick(at(2450, "mouse"))).toBe(true);
      expect(clock.follows(at(3000))).toBe(true);
      expect(clock.isTouchClick(at(3500, "mouse"))).toBe(false);
      // An end told before its start (events of another clock) does not
      // move the time back
      clock.note(at(500));
      expect(clock.follows(at(3000))).toBe(true);
    });

    it("takes a click with no touch before for a mouse's, on any device", () => {
      // An iPad's trackpad: a page that cannot hover, clicked by a pointer
      // whose click toggles a flight
      const clock = new TouchClock();
      stubMedia("(hover: none)");

      expect(clock.isTouchClick(at(100))).toBe(false);
      expect(clock.isTouchClick(at(100, "mouse"))).toBe(false);
    });
  });

  describe("the phone layout's one listener", () => {
    it("tells of a change until stopped, and names the link to go with it", () => {
      let phone = false;
      const listeners = new Set<(event: { matches: boolean }) => void>();
      Object.defineProperty(window, "matchMedia", {
        value: vi.fn(() => ({
          get matches() {
            return phone;
          },
          addEventListener: (
            _: string,
            listener: (event: { matches: boolean }) => void,
          ) => listeners.add(listener),
          removeEventListener: (
            _: string,
            listener: (event: { matches: boolean }) => void,
          ) => listeners.delete(listener),
        })),
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, "share", {
        value: vi.fn(),
        configurable: true,
      });
      try {
        const seen: [boolean, string][] = [];
        const stop = followPhoneLayout((matches) =>
          seen.push([matches, shareLinkLabel()]),
        );
        expect(shareLinkLabel()).toBe("Copy link");

        phone = true;
        for (const listener of listeners) listener({ matches: true });
        stop();

        expect(seen).toEqual([[true, "Share link"]]);
        expect(listeners.size).toBe(0);
      } finally {
        Reflect.deleteProperty(navigator, "share");
      }
    });
  });
});
