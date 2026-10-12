/**
 * Color calculation utilities for altitude and speed visualization
 */

interface ColorStop {
  r: number;
  g: number;
  b: number;
}

/** The one spelling of a colour in this module, shared with the CSS ramps */
function rgb(stop: ColorStop): string {
  return "rgb(" + stop.r + "," + stop.g + "," + stop.b + ")";
}

function interpolateGradient(
  normalized: number,
  stops: [ColorStop, ColorStop, ColorStop, ColorStop, ColorStop, ColorStop],
): string {
  const clamped = Math.max(0, Math.min(1, normalized));

  const segmentIndex = Math.min(Math.floor(clamped * 5), 4);
  const t = clamped * 5 - segmentIndex;

  const from = stops[segmentIndex as 0 | 1 | 2 | 3 | 4];
  const to = stops[Math.min(segmentIndex + 1, 5) as 0 | 1 | 2 | 3 | 4 | 5];

  return rgb({
    r: Math.round(from.r + (to.r - from.r) * t),
    g: Math.round(from.g + (to.g - from.g) * t),
    b: Math.round(from.b + (to.b - from.b) * t),
  });
}

/**
 * Altitude: plasma, sampled between 0.15 and 0.75 of the ramp.
 *
 * A rainbow was the obvious ramp and the wrong one. Its lightness is not
 * monotone, so equal steps in altitude read as unequal jumps, and its
 * green-yellow-red half is exactly where red-green colour blindness
 * collapses. Plasma rises steadily in lightness from end to end, which also
 * means an exported image survives being printed in grey.
 *
 * Plasma rather than viridis because of where the flying sits: a light
 * aircraft spends nearly all of its time between about 2,000 and 5,000 ft of
 * a scale that runs to ten thousand, and viridis crosses that band as
 * teal into green, which barely travels. Plasma crosses it as magenta into
 * orange, so two flights a thousand feet apart are two colours.
 */
const ALTITUDE_STOPS: [
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
] = [
  { r: 86, g: 2, b: 162 },
  { r: 132, g: 9, b: 165 },
  { r: 174, g: 39, b: 146 },
  { r: 206, g: 74, b: 118 },
  { r: 230, g: 110, b: 91 },
  { r: 247, g: 149, b: 64 },
];

/**
 * Groundspeed: viridis, from 0.25 to the top of the ramp.
 *
 * A second ramp has a second job beyond ordering its own values: it has to
 * say which quantity the map is drawing. The two ramps used to differ only
 * in their first and last stop, so a speed-coloured map and an
 * altitude-coloured one were indistinguishable, chips and legend included.
 * These two are never closer than 115 of 765 in RGB, and the ends are held
 * apart on purpose: plasma stops at orange rather than climbing into the
 * yellow viridis ends on. Each also passes through three stations a reader
 * can name rather than two: purple, magenta, orange for altitude, and blue,
 * green, yellow for groundspeed.
 */
const AIRSPEED_STOPS: [
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
  ColorStop,
] = [
  { r: 56, g: 88, b: 140 },
  { r: 38, g: 130, b: 142 },
  { r: 42, g: 170, b: 129 },
  { r: 110, g: 206, b: 88 },
  { r: 202, g: 224, b: 34 },
  { r: 253, g: 231, b: 37 },
];

/** CSS `linear-gradient(...)` spelling of a stop list, evenly spaced */
function gradientCss(stops: readonly ColorStop[]): string {
  const steps = stops
    .map((stop, index) => {
      const percent = (index / (stops.length - 1)) * 100;
      return `${rgb(stop)} ${percent}%`;
    })
    .join(", ");
  return `linear-gradient(to right, ${steps})`;
}

/**
 * Publish both ramps as custom properties so the legend bar and the row chips
 * paint the very same stops the paths are coloured with. Spelling them
 * out in the stylesheet as well let the legend drift away from the map.
 */
export function applyGradientTokens(root: HTMLElement): void {
  root.style.setProperty("--gradient-altitude", gradientCss(ALTITUDE_STOPS));
  root.style.setProperty("--gradient-speed", gradientCss(AIRSPEED_STOPS));
}

/**
 * Where `value` lies on a colour scale from `min` to `max`, from 0 to 1.
 * With `ranks`, the values of the data at evenly spaced ranks from `min` to
 * `max` (see rankValues), by its rank in that data: every stretch of the
 * ramp colours as many segments as any other. A light aircraft spends
 * three quarters of its flying in the lowest third of its altitudes, and
 * most of its speeds at a cruise far from its taxiing; spread evenly over
 * the values, most of the map was in a few neighbouring colours of the
 * ramp. A value that many segments share (a stretch where ranks repeat)
 * takes the middle of their ranks. Without `ranks` the scale runs evenly.
 */
export function scalePosition(
  value: number,
  min: number,
  max: number,
  ranks?: readonly number[],
): number {
  const last = (ranks?.length ?? 0) - 1;
  if (!ranks || last < 1) {
    return Math.max(0, Math.min(1, (value - min) / Math.max(max - min, 1)));
  }
  // The first rank that is not below the value, and the last one not above
  let lo = 0;
  while (lo <= last && ranks[lo]! < value) lo++;
  let hi = lo - 1;
  while (hi < last && ranks[hi + 1]! <= value) hi++;
  if (hi < 0) return 0;
  if (lo > last) return 1;
  if (lo <= hi) return (lo + hi) / 2 / last;
  // Between two ranks
  const from = ranks[hi]!;
  return (hi + (value - from) / (ranks[lo]! - from)) / last;
}

/** The altitude ramp's colour at `position` (0 to 1) along it */
export function altitudeColorAt(position: number): string {
  return interpolateGradient(position, ALTITUDE_STOPS);
}

/** The groundspeed ramp's colour at `position` (0 to 1) along it */
export function airspeedColorAt(position: number): string {
  return interpolateGradient(position, AIRSPEED_STOPS);
}

/**
 * The colour of an altitude on the scale from `minAlt` to `maxAlt`, spread
 * by `ranks` where given (see scalePosition)
 * @returns RGB color string (e.g., "rgb(255, 128, 0)")
 */
export function getColorForAltitude(
  altitude: number,
  minAlt: number,
  maxAlt: number,
  ranks?: readonly number[],
): string {
  return altitudeColorAt(scalePosition(altitude, minAlt, maxAlt, ranks));
}

/**
 * The colour of a groundspeed in knots on the scale from `minSpeed` to
 * `maxSpeed`, spread by `ranks` where given (see scalePosition)
 * @returns RGB color string (e.g., "rgb(255, 128, 0)")
 */
export function getColorForAirspeed(
  speed: number,
  minSpeed: number,
  maxSpeed: number,
  ranks?: readonly number[],
): string {
  return airspeedColorAt(scalePosition(speed, minSpeed, maxSpeed, ranks));
}

/**
 * Convert an RGB color string to RGBA with the given alpha
 */
export function rgbToRgba(rgb: string, alpha: number): string {
  return rgb.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
}
