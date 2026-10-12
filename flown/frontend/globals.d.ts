/**
 * Global type declarations
 */

import type { MapApp, MapConfig } from "./mapApp";

declare global {
  /**
   * The source hash of the build (build.js defines it); none in tests and
   * in the sources, see versioned in services/lazyImport.ts
   */
  var __BUILD__: string | undefined;

  interface Window {
    mapApp?: MapApp;

    // Map configuration
    MAP_CONFIG?: MapConfig;
  }
}

export {};
