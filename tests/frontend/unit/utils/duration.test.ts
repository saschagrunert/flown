/**
 * A length of time in the page's words, which the profile, the
 * cross-section, the hotspot tour and the cloud's readout all say
 */
import { describe, it, expect } from "vitest";
import { formatDuration } from "../../../../flown/frontend/utils/duration";

describe("formatDuration", () => {
  it("says seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45.4)).toBe("45 s");
    expect(formatDuration(59.4)).toBe("59 s");
  });

  it("says minutes under an hour, never 60 of them", () => {
    expect(formatDuration(59.6)).toBe("1 min");
    expect(formatDuration(59.5 * 60)).toBe("1 h");
    expect(formatDuration(8 * 60 + 20)).toBe("8 min");
    expect(formatDuration(3580)).toBe("1 h");
  });

  it("says hours and minutes, not a clock (regression)", () => {
    // "2:16" of a profile was minutes and seconds, and read as hours
    expect(formatDuration(2 * 3600 + 16 * 60)).toBe("2 h 16 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    // "485 min" of a cross-section
    expect(formatDuration(485 * 60)).toBe("8 h 5 min");
    expect(formatDuration(9 * 3600 + 59.8 * 60)).toBe("10 h");
  });

  it("says whole hours from ten of them, grouped", () => {
    expect(formatDuration(51 * 3600 + 38 * 60)).toBe("52 h");
    expect(formatDuration(1234.4 * 3600)).toBe("1,234 h");
  });

  it("never says less than nothing", () => {
    expect(formatDuration(-5)).toBe("0 s");
    expect(formatDuration(Number.NaN)).toBe("0 s");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0 s");
  });
});
