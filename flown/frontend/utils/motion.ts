/**
 * Whether the user asked the system for reduced motion. The stylesheet
 * handles CSS animations on its own. The map's are scripted, so when this is
 * true the map is created with `reduceMotion` and without its tile fade, and
 * the callers that move it pass `animate: false`.
 *
 * The replay asks on every frame it pans; the list of the query is kept
 * with the others the page asks (utils/device.ts).
 */
import { matchesMedia } from "./device";

export function prefersReducedMotion(): boolean {
  return matchesMedia("(prefers-reduced-motion: reduce)");
}
