import { describe, it, expect, vi } from "vitest";
import { frameCoalescer } from "../../../../flown/frontend/utils/frameCoalescer";
import { stubAnimationFrames } from "../../testHelpers";

describe("frameCoalescer", () => {
  it("draws once per frame, with the latest value", () => {
    const frames = stubAnimationFrames();
    const draw = vi.fn<(value: number) => void>();
    const coalescer = frameCoalescer(draw);

    coalescer.schedule(1);
    coalescer.schedule(2);
    coalescer.schedule(3);

    expect(frames.pending()).toBe(1);
    expect(draw).not.toHaveBeenCalled();
    frames.run();
    expect(draw).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("asks for a new frame once the last one has run", () => {
    const frames = stubAnimationFrames();
    const draw = vi.fn<(value: string) => void>();
    const coalescer = frameCoalescer(draw);

    coalescer.schedule("a");
    frames.run();
    coalescer.schedule("b");
    frames.run();

    expect(draw.mock.calls).toEqual([["a"], ["b"]]);
  });

  it("can schedule again from within the draw", () => {
    const frames = stubAnimationFrames();
    const drawn: number[] = [];
    const coalescer = frameCoalescer<number>((value) => {
      drawn.push(value);
      if (value < 2) coalescer.schedule(value + 1);
    });

    coalescer.schedule(1);
    frames.run();
    frames.run();

    expect(drawn).toEqual([1, 2]);
  });

  it("drops the waiting frame on cancel, and works again afterwards", () => {
    const frames = stubAnimationFrames();
    const draw = vi.fn<(value: number) => void>();
    const coalescer = frameCoalescer(draw);

    coalescer.schedule(1);
    coalescer.cancel();
    coalescer.cancel();
    frames.run();
    expect(frames.pending()).toBe(0);
    expect(draw).not.toHaveBeenCalled();

    coalescer.schedule(2);
    frames.run();
    expect(draw).toHaveBeenCalledExactlyOnceWith(2);
  });
});
