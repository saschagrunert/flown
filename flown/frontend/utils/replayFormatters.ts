/**
 * The formats of the replay readout and the flight profile: a clock and a
 * groundspeed. Only the feature bundle prints them, so they are kept out of
 * formatters.ts, which the first visit carries.
 */
import { formatNumber } from "./formatters";

/**
 * Format seconds into human-readable time string
 * @param seconds - Total seconds
 * @param span - A time the result is to line up with: from an hour on,
 *   hours are shown even when `seconds` has none ("0:05:30")
 * @returns Formatted time (e.g., "2:30:45" or "5:30")
 */
export function formatTime(seconds: number, span: number = seconds): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0 || span >= 3600) {
    return (
      hours +
      ":" +
      minutes.toString().padStart(2, "0") +
      ":" +
      secs.toString().padStart(2, "0")
    );
  }

  return minutes + ":" + secs.toString().padStart(2, "0");
}

/**
 * Format speed in knots to human-readable string
 * @param knots - Speed in knots
 * @returns Formatted speed (e.g., "120 kt")
 */
export function formatSpeed(knots: number): string {
  return formatNumber(knots) + " kt";
}
