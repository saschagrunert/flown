import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout } from "../../../../flown/frontend/utils/withTimeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles like the promise when it is in time, and drops the timer", async () => {
    await expect(withTimeout(Promise.resolve(7), 100, "late")).resolves.toBe(7);
    await expect(
      withTimeout(Promise.reject(new Error("broken")), 100, "late"),
    ).rejects.toThrow("broken");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the message once the time is up", async () => {
    const result = withTimeout(new Promise(() => {}), 100, "late");
    const settled = vi.fn();
    result.catch(settled);

    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).rejects.toThrow("late");
  });

  it("keeps its answer when the promise settles after all", async () => {
    let resolve!: (value: number) => void;
    const result = withTimeout(
      new Promise<number>((r) => (resolve = r)),
      100,
      "late",
    );
    result.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    resolve(7);

    await expect(result).rejects.toThrow("late");
  });
});
