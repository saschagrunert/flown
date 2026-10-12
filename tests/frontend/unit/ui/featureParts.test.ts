/**
 * The parts of the lazy features an app keeps once made (featurePart in
 * ui/lazyBundles.ts): the controls of the replay of all flights, the
 * hotspot tour, the cross-section and the player of Wrapped's intro.
 */
import { describe, it, expect } from "vitest";
import type { CrossSectionTool } from "../../../../flown/frontend/ui/crossSection";
import { featurePart } from "../../../../flown/frontend/ui/lazyBundles";

/** A tool that is never opened, which is all the registry asks of it */
const tool = (): CrossSectionTool => ({ toggle() {}, isOpen: () => false });

describe("featurePart", () => {
  it("makes a part the first time it is asked for with a maker, and finds it after", () => {
    const app = { signal: new AbortController().signal };
    expect(featurePart(app, "crossSection")).toBeUndefined();

    const made = featurePart(app, "crossSection", tool);
    expect(featurePart(app, "crossSection", tool)).toBe(made);
    expect(featurePart(app, "crossSection")).toBe(made);
  });

  it("keeps the parts of each app apart", () => {
    const one = { signal: new AbortController().signal };
    const other = { signal: new AbortController().signal };
    const made = featurePart(one, "crossSection", tool);

    expect(featurePart(other, "crossSection")).toBeUndefined();
    expect(featurePart(other, "crossSection", tool)).not.toBe(made);
  });

  it("forgets the parts of an app that is destroyed", () => {
    const lifetime = new AbortController();
    const app = { signal: lifetime.signal };
    featurePart(app, "crossSection", tool);

    lifetime.abort();

    expect(featurePart(app, "crossSection")).toBeUndefined();
  });
});
