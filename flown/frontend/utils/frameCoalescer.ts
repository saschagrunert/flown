/**
 * Draw at most once per animation frame, with the latest value.
 *
 * For values that arrive many times per frame, of which only the last is
 * ever seen: the chunks of a download, the moves of a pointer, the
 * positions of a replay. `schedule` keeps the value and asks for one frame;
 * `cancel` drops a frame that is still waiting, for when what it would draw
 * into is going away. The value is let go of once it is drawn or dropped.
 */
export interface FrameCoalescer<T> {
  schedule(value: T): void;
  cancel(): void;
}

export function frameCoalescer<T>(draw: (value: T) => void): FrameCoalescer<T> {
  let frame: number | null = null;
  let latest: T | undefined;
  return {
    schedule(value) {
      latest = value;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        const value = latest as T;
        latest = undefined;
        draw(value);
      });
    },
    cancel() {
      if (frame === null) return;
      cancelAnimationFrame(frame);
      frame = null;
      latest = undefined;
    },
  };
}
