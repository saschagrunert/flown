import { describe, it, expect, afterEach, vi } from "vitest";
import {
  storedFlag,
  storeFlag,
} from "../../../../flown/frontend/utils/storedFlag";

describe("storedFlag", () => {
  const key = "flown-test-flag";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a flag until it is cleared", () => {
    expect(storedFlag(key)).toBe(false);

    storeFlag(key, true);
    expect(localStorage.getItem(key)).toBe("1");
    expect(storedFlag(key)).toBe(true);

    storeFlag(key, false);
    expect(localStorage.getItem(key)).toBeNull();
    expect(storedFlag(key)).toBe(false);
  });

  it("reads as no, and keeps nothing, where the storage throws", () => {
    const fail = (): never => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(fail);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(fail);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(fail);

    expect(storedFlag(key)).toBe(false);
    expect(() => storeFlag(key, true)).not.toThrow();
    expect(() => storeFlag(key, false)).not.toThrow();
  });
});
