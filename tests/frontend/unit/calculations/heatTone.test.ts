/**
 * The roll-off of the heat before its colours: as it is up to the knee,
 * a logarithm beyond, and back again for the legend.
 */
import { describe, it, expect } from "vitest";
import {
  HEAT_KNEE,
  heatTone,
  heatUntone,
} from "../../../../flown/frontend/calculations/heatTone";

describe("heatTone", () => {
  it("leaves the heat up to the knee as it is", () => {
    for (const heat of [0, 0.25, 1, 4, HEAT_KNEE]) {
      expect(heatTone(heat)).toBe(heat);
    }
  });

  it("rolls the heat beyond the knee off, gradually and without a kink", () => {
    // A knee's worth more colour for every factor of e more heat
    expect(heatTone(HEAT_KNEE * Math.E)).toBeCloseTo(2 * HEAT_KNEE, 12);
    expect(heatTone(HEAT_KNEE * Math.E ** 2)).toBeCloseTo(3 * HEAT_KNEE, 12);
    // Still growing, and as steep as the heat at the knee
    const slope = (heatTone(HEAT_KNEE + 1e-6) - HEAT_KNEE) / 1e-6;
    expect(slope).toBeCloseTo(1, 5);
    // Hundreds of circuits over a home field keep a few steps of colour
    // rather than all going past the ramp's white at 64
    expect(heatTone(100)).toBeLessThan(64);
    expect(heatTone(1000)).toBeLessThan(64);
    expect(heatTone(1000) - heatTone(100)).toBeGreaterThan(HEAT_KNEE);
  });

  it("is undone by heatUntone", () => {
    for (const heat of [0.5, 3, HEAT_KNEE, 40, 800, 5000]) {
      expect(heatUntone(heatTone(heat))).toBeCloseTo(heat, 9);
    }
  });
});
