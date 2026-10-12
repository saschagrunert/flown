import { describe, it, expect, vi } from "vitest";
import {
  countryDisplayName,
  formatNumber,
  formatFileSize,
  formatTrack,
} from "../../../../flown/frontend/utils/formatters";
import {
  formatTime,
  formatSpeed,
} from "../../../../flown/frontend/utils/replayFormatters";
import { formatBuildDate } from "../../../../flown/frontend/utils/statsFormat";

describe("formatter utilities", () => {
  describe("formatFileSize", () => {
    it("formats bytes, KB, MB and GB", () => {
      expect(formatFileSize(0)).toBe("0 B");
      expect(formatFileSize(512)).toBe("512 B");
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(15 * 1024)).toBe("15 KB");
      expect(formatFileSize(1.1 * 1024 * 1024)).toBe("1.1 MB");
      expect(formatFileSize(24 * 1024 * 1024)).toBe("24 MB");
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
    });

    it("handles invalid input", () => {
      expect(formatFileSize(-1)).toBe("0 B");
      expect(formatFileSize(NaN)).toBe("0 B");
      expect(formatFileSize(Infinity)).toBe("0 B");
    });
  });

  describe("formatTime", () => {
    it("formats time with hours, minutes, and seconds", () => {
      expect(formatTime(3661)).toBe("1:01:01");
    });

    it("formats time with only minutes and seconds", () => {
      expect(formatTime(330)).toBe("5:30");
    });

    it("pads single-digit minutes and seconds when hours present", () => {
      expect(formatTime(3605)).toBe("1:00:05");
    });

    it("handles zero seconds", () => {
      expect(formatTime(0)).toBe("0:00");
    });

    it("shows hours when the time it lines up with has them", () => {
      // The elapsed time of a replay, beside a total of over an hour
      expect(formatTime(206, 12177)).toBe("0:03:26");
      expect(formatTime(0, 3600)).toBe("0:00:00");
      expect(formatTime(206, 3599)).toBe("3:26");
    });

    it("formats large time values", () => {
      expect(formatTime(36000)).toBe("10:00:00");
    });

    it("handles 59 seconds (edge case)", () => {
      expect(formatTime(59)).toBe("0:59");
    });

    it("handles exactly 1 hour", () => {
      expect(formatTime(3600)).toBe("1:00:00");
    });

    it("handles exactly 1 minute", () => {
      expect(formatTime(60)).toBe("1:00");
    });
  });

  describe("formatSpeed", () => {
    it("formats speed in knots", () => {
      expect(formatSpeed(120)).toBe("120 kt");
    });

    it("rounds to nearest knot", () => {
      expect(formatSpeed(120.6)).toBe("121 kt");
    });

    it("handles zero speed", () => {
      expect(formatSpeed(0)).toBe("0 kt");
    });

    it("formats high speeds", () => {
      expect(formatSpeed(1234)).toBe("1,234 kt");
    });

    it("rounds down decimal values", () => {
      expect(formatSpeed(120.4)).toBe("120 kt");
    });
  });

  describe("formatNumber", () => {
    it("groups digits so long figures stay readable", () => {
      expect(formatNumber(264400)).toBe("264,400");
      expect(formatNumber(1700)).toBe("1,700");
      expect(formatNumber(999)).toBe("999");
    });

    it("keeps a fixed number of decimals when asked", () => {
      expect(formatNumber(12610.55, 1)).toBe("12,610.6");
      expect(formatNumber(30, 1)).toBe("30.0");
    });

    it("rounds to whole numbers by default", () => {
      expect(formatNumber(1234.6)).toBe("1,235");
    });

    it("falls back to zero for values that are not finite", () => {
      expect(formatNumber(Number.NaN)).toBe("0");
      expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
    });

    it("makes one formatter per number of decimals and reuses it", () => {
      const made = vi.spyOn(Intl, "NumberFormat");
      try {
        // Two counts of decimals no other test in this file asks for
        formatNumber(1.5, 3);
        formatNumber(2.5, 3);
        formatNumber(3.25, 4);
        formatNumber(4.25, 4);
        expect(made).toHaveBeenCalledTimes(2);
        expect(formatNumber(1234.5678, 3)).toBe("1,234.568");
      } finally {
        made.mockRestore();
      }
    });
  });

  describe("formatBuildDate", () => {
    it("formats the day in English", () => {
      expect(formatBuildDate("2026-09-21")).toBe("21 Sep 2026");
      expect(formatBuildDate("2027-01-05")).toBe("5 Jan 2027");
    });

    it("rejects anything that is not a date, a time of day included", () => {
      expect(formatBuildDate("")).toBeNull();
      expect(formatBuildDate("2026-13-01")).toBeNull();
      expect(formatBuildDate("2026-09-21T14:03Z")).toBeNull();
      expect(formatBuildDate("<b>")).toBeNull();
    });
  });
});

describe("countryDisplayName", () => {
  it("converts ISO code to full country name", () => {
    expect(countryDisplayName("DE")).toBe("Germany");
    expect(countryDisplayName("US")).toBe("United States");
    expect(countryDisplayName("FR")).toBe("France");
  });

  it("returns a non-empty string for unknown codes and the input for invalid ones", () => {
    const unknown = countryDisplayName("ZZ");
    expect(typeof unknown).toBe("string");
    expect(unknown.length).toBeGreaterThan(0);
    // Intl throws on malformed region codes; the input is returned as is
    expect(countryDisplayName("not a code")).toBe("not a code");
  });
});

describe("formatTrack", () => {
  it("pads to three digits", () => {
    expect(formatTrack(7)).toBe("007°");
    expect(formatTrack(72.4)).toBe("072°");
    expect(formatTrack(359.6)).toBe("000°");
  });

  it("normalises into 0-359", () => {
    expect(formatTrack(-45)).toBe("315°");
    expect(formatTrack(400)).toBe("040°");
    expect(formatTrack(360)).toBe("000°");
  });
});
