/**
 * A length of time in the page's words. Beside utils/formatters.ts rather
 * than in it: only the feature bundle says one (the profile, the
 * cross-section, the hotspot tour, the cloud's readout), and a module the
 * app reaches is part of every first visit, whatever of it the app uses.
 */
import { formatNumber } from "./formatters";

/**
 * A length of time as "45 s", "8 min", "2 h 16 min", or from ten hours in
 * whole hours ("51 h"): a total or a share of one, where a clock's "2:16"
 * read as hours and minutes when it was minutes and seconds. What runs as
 * a clock (the replays, the axes of a chart) keeps formatTime. Never a time
 * of day.
 * @param seconds - The time, in seconds
 */
export function formatDuration(seconds: number): string {
  // Nothing measured is nothing, rather than "NaN h"
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (whole < 60) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  // Not "60 min" for a little under the hour, nor "9 h 60 min"
  if (minutes < 60) return `${minutes} min`;
  if (minutes >= 600) return `${formatNumber(Math.round(minutes / 60))} h`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}
