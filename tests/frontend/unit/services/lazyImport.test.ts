/**
 * The URLs the app fetches a lazy file by: the build it belongs to, and a
 * new one for every retry (services/lazyImport.ts)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importWithRetry,
  versioned,
} from "../../../../flown/frontend/services/lazyImport";

/** What an import of `file` asked for, from the failure there is */
const asked = async (file: string, failedImports: number): Promise<string> =>
  String(
    await importWithRetry(
      () => Promise.reject(new Error("the literal import")),
      file,
      failedImports,
    ).catch((error: unknown) => error),
  );

describe("versioned", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the build a file belongs to, where there is one", () => {
    vi.stubGlobal("__BUILD__", "0123456789ab");
    expect(versioned("./features.css")).toBe("./features.css?v=0123456789ab");
  });

  it("leaves the URL alone without a build, as in the sources", () => {
    expect(versioned("./features.css")).toBe("./features.css");
  });
});

describe("importWithRetry", () => {
  it("takes the literal import first, for a file named without a query", async () => {
    expect(await asked("./none.bundle.js", 0)).toContain("the literal import");
  });

  it("imports a file named with its build by that name, and adds the retry", async () => {
    // There is no such file next to the sources, so the import fails and
    // says what it asked for
    const first = await asked("./none.bundle.js?v=0123456789ab", 0);
    expect(first).not.toContain("the literal import");
    expect(first).toContain("/none.bundle.js?v=0123456789ab");
    expect(first).not.toContain("retry");
    expect(await asked("./none.bundle.js?v=0123456789ab", 2)).toContain(
      "/none.bundle.js?v=0123456789ab&retry=2",
    );
    expect(await asked("./none.bundle.js", 1)).toContain(
      "/none.bundle.js?retry=1",
    );
  });
});
