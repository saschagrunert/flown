import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { tightenMarkup } from "./scripts/build-helpers.js";

export default defineConfig({
  // The popups as a minified build ships them (the markup plugin of
  // build.js), so the tests see the markup the site does
  plugins: [
    {
      name: "markup",
      enforce: "pre",
      transform(code, id) {
        return /[\\/]utils[\\/]htmlGenerators\.ts$/.test(id)
          ? { code: tightenMarkup(code, id), map: null }
          : undefined;
      },
    },
  ],
  test: {
    globals: true,
    environment: "jsdom",
    // One jsdom per worker instead of one per test file. vmThreads keeps the
    // per-file module isolation the suite relies on and drops the environment
    // setup, which otherwise dominated the run. It needs window.location to
    // stay configurable, so tests move the location through history.
    pool: "vmThreads",
    // Every spy, stubbed global and stubbed variable is put back before the
    // next test, so no file has to remember an afterEach for it and a spy
    // cannot leak into the tests after the one that made it
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    setupFiles: ["tests/frontend/setup.ts"],
    include: [
      "tests/frontend/unit/**/*.test.ts",
      "tests/frontend/contract/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      // The build scripts as well, as pytest measures scripts/*.py: a script
      // only CI runs still shows when its tests stop reaching it. build.js
      // itself builds as it is imported, so its helpers live in scripts/.
      include: ["flown/frontend/**/*.{js,ts}", "scripts/*.js"],
      exclude: ["**/node_modules/**"],
      clean: true,
      // One to three points below what the suite reaches, so a real
      // regression fails the build while a new defensive branch does not.
      // Codecov enforces patch coverage on top.
      thresholds: {
        lines: 98,
        branches: 91,
        functions: 97,
        statements: 97,
      },
    },
    alias: {
      "maplibre-gl": fileURLToPath(
        new URL("./tests/mocks/maplibre-gl.ts", import.meta.url),
      ),
    },
  },
});
