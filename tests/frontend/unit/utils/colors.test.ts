import { describe, it, expect } from "vitest";
import {
  applyGradientTokens,
  getColorForAltitude,
  getColorForAirspeed,
  rgbToRgba,
  scalePosition,
} from "../../../../flown/frontend/utils/colors";

/**
 * Split an "rgb(r,g,b)" string into its components so the tests can assert on
 * the channels. Test-only: the application compares the strings themselves.
 */
function parseRgb(rgbString: string): { r: number; g: number; b: number } {
  const match = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgbString);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(match[1]!, 10),
    g: parseInt(match[2]!, 10),
    b: parseInt(match[3]!, 10),
  };
}

/**
 * WCAG relative luminance of a colour string. Both ramps are perceptually
 * uniform, which in practice means this rises from one end to the other; the
 * tests assert that rather than naming hues, so a later ramp swap that keeps
 * the property keeps passing.
 */
function luminance(rgbString: string): number {
  const { r, g, b } = parseRgb(rgbString);
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

describe("color utilities", () => {
  describe("getColorForAltitude", () => {
    it("darkens towards the bottom of the range and lightens to the top", () => {
      const low = getColorForAltitude(0, 0, 10000);
      const high = getColorForAltitude(10000, 0, 10000);

      expect(luminance(low)).toBeLessThan(luminance(high));
    });

    it("rises in lightness at every step, so equal steps read as equal", () => {
      for (let alt = 0; alt < 10000; alt += 500) {
        const here = luminance(getColorForAltitude(alt, 0, 10000));
        const next = luminance(getColorForAltitude(alt + 500, 0, 10000));
        expect(next).toBeGreaterThan(here);
      }
    });

    it("stays clear of the basemap at its darkest end", () => {
      // #141414, the page background under the tiles
      const background = 0.0144;
      expect(luminance(getColorForAltitude(0, 0, 10000))).toBeGreaterThan(
        background * 3,
      );
    });

    it("clamps values below minimum to minimum color", () => {
      const color1 = getColorForAltitude(-1000, 0, 10000);
      const color2 = getColorForAltitude(0, 0, 10000);
      expect(color1).toBe(color2);
    });

    it("clamps values above maximum to maximum color", () => {
      const color1 = getColorForAltitude(15000, 0, 10000);
      const color2 = getColorForAltitude(10000, 0, 10000);
      expect(color1).toBe(color2);
    });

    it("handles zero range (min === max)", () => {
      const color = getColorForAltitude(5000, 5000, 5000);
      const { r, g, b } = parseRgb(color);

      // Should return minimum color when range is zero
      expect(typeof r).toBe("number");
      expect(typeof g).toBe("number");
      expect(typeof b).toBe("number");
    });

    it("returns valid RGB string format", () => {
      const color = getColorForAltitude(5000, 0, 10000);
      expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it("produces smooth gradient across range", () => {
      const colors = [];
      for (let i = 0; i <= 10; i++) {
        const alt = i * 1000;
        colors.push(getColorForAltitude(alt, 0, 10000));
      }

      // All colors should be unique (smooth gradient)
      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBeGreaterThan(5);
    });
  });

  describe("getColorForAirspeed", () => {
    it("rises in lightness at every step", () => {
      for (let speed = 0; speed < 200; speed += 10) {
        const here = luminance(getColorForAirspeed(speed, 0, 200));
        const next = luminance(getColorForAirspeed(speed + 10, 0, 200));
        expect(next).toBeGreaterThan(here);
      }
    });

    it("stays clear of the basemap at its darkest end", () => {
      const background = 0.0144;
      expect(luminance(getColorForAirspeed(0, 0, 200))).toBeGreaterThan(
        background * 3,
      );
    });

    it("shares no hue with the altitude ramp", () => {
      // The two ramps have to say which quantity is on the map, not only
      // order their own values. They used to differ by one stop at each end.
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const altitude = parseRgb(getColorForAltitude(t, 0, 1));
        const speed = parseRgb(getColorForAirspeed(t, 0, 1));
        const distance =
          Math.abs(altitude.r - speed.r) +
          Math.abs(altitude.g - speed.g) +
          Math.abs(altitude.b - speed.b);
        expect(distance).toBeGreaterThan(90);
      }
    });

    it("clamps values below minimum", () => {
      const color1 = getColorForAirspeed(-50, 0, 200);
      const color2 = getColorForAirspeed(0, 0, 200);
      expect(color1).toBe(color2);
    });

    it("clamps values above maximum", () => {
      const color1 = getColorForAirspeed(300, 0, 200);
      const color2 = getColorForAirspeed(200, 0, 200);
      expect(color1).toBe(color2);
    });

    it("handles zero range", () => {
      const color = getColorForAirspeed(100, 100, 100);
      expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it("returns valid RGB string format", () => {
      const color = getColorForAirspeed(100, 0, 200);
      expect(color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    });

    it("produces smooth gradient", () => {
      const colors = [];
      for (let i = 0; i <= 10; i++) {
        const speed = i * 20;
        colors.push(getColorForAirspeed(speed, 0, 200));
      }

      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBeGreaterThan(5);
    });
  });

  describe("rgbToRgba", () => {
    it("converts rgb to rgba with given alpha", () => {
      expect(rgbToRgba("rgb(255,128,0)", 0.5)).toBe("rgba(255,128,0, 0.5)");
    });

    it("converts rgb with spaces to rgba", () => {
      expect(rgbToRgba("rgb(255, 128, 0)", 0.15)).toBe(
        "rgba(255, 128, 0, 0.15)",
      );
    });

    it("handles alpha of 0", () => {
      expect(rgbToRgba("rgb(0,0,0)", 0)).toBe("rgba(0,0,0, 0)");
    });

    it("handles alpha of 1", () => {
      expect(rgbToRgba("rgb(255,255,255)", 1)).toBe("rgba(255,255,255, 1)");
    });
  });

  describe("applyGradientTokens", () => {
    it("publishes both ramps as custom properties", () => {
      const root = document.createElement("div");
      applyGradientTokens(root);

      const altitude = root.style.getPropertyValue("--gradient-altitude");
      const speed = root.style.getPropertyValue("--gradient-speed");

      expect(altitude).toContain("linear-gradient(to right,");
      expect(speed).toContain("linear-gradient(to right,");
      // First and last stop of each ramp, at the ends of the scale
      expect(altitude).toContain("rgb(86,2,162) 0%");
      expect(altitude).toContain("rgb(247,149,64) 100%");
      expect(speed).toContain("rgb(56,88,140) 0%");
      expect(speed).toContain("rgb(253,231,37) 100%");
    });

    it("matches the colours the paths are drawn with", () => {
      const root = document.createElement("div");
      applyGradientTokens(root);

      // The chip and the polyline have to agree at both ends of the scale
      expect(root.style.getPropertyValue("--gradient-altitude")).toContain(
        getColorForAltitude(0, 0, 100) + " 0%",
      );
      expect(root.style.getPropertyValue("--gradient-speed")).toContain(
        getColorForAirspeed(100, 0, 100) + " 100%",
      );
    });
  });
});

describe("scalePosition", () => {
  const ranks = [0, 100, 200, 200, 200, 1000];

  it("runs evenly between the ends without ranks", () => {
    expect(scalePosition(2500, 0, 10000)).toBe(0.25);
    expect(scalePosition(-5, 0, 10000)).toBe(0);
    expect(scalePosition(20000, 0, 10000)).toBe(1);
  });

  it("goes by rank between the ranks it is given, the ends clamped", () => {
    expect(scalePosition(-10, 0, 1000, ranks)).toBe(0);
    expect(scalePosition(0, 0, 1000, ranks)).toBe(0);
    expect(scalePosition(50, 0, 1000, ranks)).toBeCloseTo(0.1, 9);
    // Between 200 and 1000, the last fifth of the ranks
    expect(scalePosition(600, 0, 1000, ranks)).toBeCloseTo(0.9, 9);
    expect(scalePosition(1000, 0, 1000, ranks)).toBe(1);
    expect(scalePosition(5000, 0, 1000, ranks)).toBe(1);
  });

  it("gives a value many share the middle of their ranks", () => {
    // 200 is the rank of 0.4, 0.6 and 0.8
    expect(scalePosition(200, 0, 1000, ranks)).toBeCloseTo(0.6, 9);
  });

  it("is the same colour either way for the same position", () => {
    expect(getColorForAltitude(600, 0, 1000, ranks)).toBe(
      getColorForAltitude(900, 0, 1000),
    );
  });
});
