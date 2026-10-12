/**
 * The roll-off of the heat before its colours: how many flights' worth of
 * heat, as drawn (see ui/heatScale.ts), a place is coloured as. Up to
 * HEAT_KNEE as many as it has; beyond it a logarithm, so every time the
 * heat grows by a factor of e the colour moves on by as much as the knee
 * itself.
 *
 * The heat of the flights adds up, and the ramp ends in white. A home
 * field flown for years holds hundreds of times the heat of its busiest
 * routes, and drawn as it is every circuit of it went past white: the
 * downwind, the base, the final and the runway merged into one flat white
 * racetrack with a hard edge. Rolled off, the busiest places keep a few
 * steps of their own on the top of the ramp, white only where the heat is
 * some three hundred times the knee, while everything up to the knee, a
 * lone flight or a route flown a few times, is drawn as before. The flat
 * heatmap, its heat lines and the cloud of the 3D view roll their heat off
 * alike (see exposedHeat in calculations/heatExposure.ts, heatLineTone
 * below and markStretches in calculations/cloudCells.ts), and
 * the heat legend reads its colours back through heatUntone.
 */

/**
 * The flights' worth, as drawn, from which the heat rolls off: the light
 * cyan the flat heatmap's exposure draws the busiest routes in (see
 * heatExposure in calculations/heatExposure.ts)
 */
export const HEAT_KNEE = 10;

/** The flights' worth `heat` is coloured as (see above) */
export function heatTone(heat: number): number {
  return heat > HEAT_KNEE ? HEAT_KNEE * (1 + Math.log(heat / HEAT_KNEE)) : heat;
}

/** The flights' worth drawn in the colour of `tone`: heatTone backwards */
export function heatUntone(tone: number): number {
  return tone > HEAT_KNEE ? HEAT_KNEE * Math.exp(tone / HEAT_KNEE - 1) : tone;
}

/**
 * The seconds around a stretch (see calculations/heatLines.ts) a lone pass
 * is drawn with: the time between two fixes, about 5 s, which the lines
 * round to a power of two. The heat lines' flight's worth, as
 * HEAT_FLIGHT_DENSITY is the heatmap's (see ui/heatmapPaint.ts).
 */
export const HEAT_LINE_FLIGHT_SECONDS = 4;

/**
 * The seconds around a stretch of the heat lines, as drawn, rolled off as
 * the heatmap rolls off its heat (see heatTone): counted in flights' worth
 * of HEAT_LINE_FLIGHT_SECONDS each, so the busiest circuits and taxiways
 * keep the colours the heatmap gave them across the hand-over
 */
export function heatLineTone(seconds: number): number {
  return (
    HEAT_LINE_FLIGHT_SECONDS * heatTone(seconds / HEAT_LINE_FLIGHT_SECONDS)
  );
}
