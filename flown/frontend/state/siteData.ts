/**
 * What the site publishes beside the flights: the airports (airports.json)
 * and the index of the export (metadata.json). The data loader fills it
 * (services/dataLoader.ts) and is its only writer; the code that needs it
 * without a loader at hand reads it here: the country of an airport and
 * the flags the site carries (features/airports.ts), the markers
 * (ui/airportManager.ts) and Wrapped's map. Each stays null until its file
 * has loaded.
 */
import type { Airport, Metadata } from "../types";

export interface SiteData {
  airports: Airport[] | null;
  metadata: Metadata | null;
}

export const siteData: SiteData = { airports: null, metadata: null };

/** Forget what was loaded (used by tests) */
export function resetSiteData(): void {
  siteData.airports = null;
  siteData.metadata = null;
}
