/**
 * The insets of the safe area, read off a hidden probe whose padding is
 * env(safe-area-inset-*): zero where there is none, measured once, and
 * again when the window changes size (a phone turns).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  resetSafeArea,
  safeAreaInsets,
} from "../../../../flown/frontend/utils/safeArea";
import { measureSafeArea } from "../../testHelpers";

describe("safeAreaInsets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetSafeArea();
  });

  it("is zero where the browser has no safe area", () => {
    expect(safeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("reads the insets off a hidden probe on the page", () => {
    measureSafeArea({ top: 59, bottom: 34 });

    expect(safeAreaInsets()).toEqual({
      top: 59,
      right: 0,
      bottom: 34,
      left: 0,
    });
    const probe = document.getElementById("safe-area-probe")!;
    expect(probe.parentElement).toBe(document.body);
    expect(probe.style.position).toBe("fixed");
    expect(probe.style.visibility).toBe("hidden");
  });

  it("measures once, and again when the window changes size", () => {
    const measure = measureSafeArea({ top: 59, bottom: 34 });
    safeAreaInsets();
    safeAreaInsets();
    expect(measure).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    measureSafeArea({ right: 59, bottom: 21, left: 59 });
    expect(safeAreaInsets().left).toBe(0);
    window.dispatchEvent(new Event("resize"));
    expect(safeAreaInsets()).toEqual({
      top: 0,
      right: 59,
      bottom: 21,
      left: 59,
    });
  });

  it("measures again when the phone turns, ahead of the resize", () => {
    measureSafeArea({ top: 59, bottom: 34 });
    safeAreaInsets();
    vi.restoreAllMocks();
    measureSafeArea({ right: 59, bottom: 21, left: 59 });
    window.dispatchEvent(new Event("orientationchange"));
    expect(safeAreaInsets().right).toBe(59);
  });

  it("drops the probe with the app", () => {
    safeAreaInsets();
    resetSafeArea();
    expect(document.getElementById("safe-area-probe")).toBeNull();
  });

  it("measures nothing after the app's teardown, until an app starts", () => {
    measureSafeArea({ top: 59 });
    safeAreaInsets();
    resetSafeArea(true);

    // A frame or a pan scheduled before the teardown
    expect(safeAreaInsets()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(document.getElementById("safe-area-probe")).toBeNull();

    resetSafeArea();
    expect(safeAreaInsets().top).toBe(59);
  });
});
