import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initLogger,
  logDebug,
  logError,
} from "../../../../flown/frontend/utils/logger";

describe("logger utilities", () => {
  beforeEach(() => {
    // Move the real location rather than replacing the property: redefining
    // it makes it non-configurable for the rest of the worker
    window.history.replaceState(null, "", "/");

    // Force logger to re-initialize by calling initLogger
    // This ensures each test starts with a clean state
    initLogger();
  });

  describe("logDebug", () => {
    it("logs when debug is enabled", () => {
      window.history.replaceState(null, "", "/?debug=true");
      initLogger(); // Initialize with debug enabled

      const consoleSpy = vi.spyOn(console, "log");

      logDebug("debug message", 123);
      expect(consoleSpy).toHaveBeenCalledWith("debug message", 123);
    });

    it("does not log when debug is disabled", () => {
      window.history.replaceState(null, "", "/");
      initLogger(); // Initialize with debug disabled

      const consoleSpy = vi.spyOn(console, "log");

      logDebug("debug message");
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("logError", () => {
    it("always logs errors", () => {
      const consoleSpy = vi.spyOn(console, "error");

      logError("error message");
      expect(consoleSpy).toHaveBeenCalledWith("error message");
    });

    it("logs errors with error objects", () => {
      const consoleSpy = vi.spyOn(console, "error");
      const error = new Error("test error");

      logError("Failed:", error);
      expect(consoleSpy).toHaveBeenCalledWith("Failed:", error);
    });
  });
});
