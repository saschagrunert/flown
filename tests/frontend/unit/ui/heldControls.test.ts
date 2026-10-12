/**
 * The controls a replay, the replay of all flights or the hotspot tour
 * hold while it runs, and give back as each was
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  heldReason,
  holdControls,
  REPLAY_HELD_CONTROL_IDS,
  SELECTION_CONTROL_IDS,
} from "../../../../flown/frontend/ui/heldControls";
import { setUnavailable } from "../../../../flown/frontend/utils/buttonState";

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/toast", () => toastMock);

/** The mode that holds the controls */
const WHY = "the replay";
/** What a held control says */
const REASON = "End the replay to change this";

describe("holdControls", () => {
  let root: HTMLElement;
  const control = (id: string): HTMLButtonElement | HTMLSelectElement =>
    document.getElementById(id) as HTMLButtonElement | HTMLSelectElement;

  beforeEach(() => {
    toastMock.showToast.mockClear();
    root = document.createElement("div");
    root.innerHTML =
      '<button id="heatmap-btn"></button>' +
      '<button id="airspeed-btn" aria-disabled="true" aria-describedby="airspeed-reason"></button>' +
      '<select id="year-select"></select>' +
      '<div id="stats-rail"></div>';
    document.body.append(root);
  });

  afterEach(() => {
    root.remove();
  });

  it("holds the buttons with aria-disabled, and disables the selects", () => {
    const release = holdControls(
      ["heatmap-btn", "airspeed-btn", "year-select", "stats-rail"],
      WHY,
    );

    // In the tab order, to say why: disabled took them out of it
    expect(control("heatmap-btn").disabled).toBe(false);
    expect(control("heatmap-btn").getAttribute("aria-disabled")).toBe("true");
    expect(control("airspeed-btn").getAttribute("aria-disabled")).toBe("true");
    // A select would open its list whatever aria-disabled said
    expect(control("year-select").disabled).toBe(true);
    // Not a control, and missing ones are no error
    expect(document.getElementById("stats-rail")!.dataset["held"]).toBe(
      undefined,
    );
    expect(() => holdControls(["no-such-btn"], WHY)()).not.toThrow();
    release();
  });

  it("describes each held button by the way to have it back", () => {
    const release = holdControls(["heatmap-btn", "airspeed-btn"], WHY);

    for (const id of ["heatmap-btn", "airspeed-btn"]) {
      const reason = document.getElementById(
        control(id).getAttribute("aria-describedby")!,
      );
      expect(reason?.textContent).toBe(REASON);
    }

    release();
    expect(control("heatmap-btn").hasAttribute("aria-describedby")).toBe(false);
    expect(control("airspeed-btn").getAttribute("aria-describedby")).toBe(
      "airspeed-reason",
    );
    expect(document.querySelector('[id^="held-reason"]')).toBeNull();
  });

  it("refuses a click on a held button, and says why", () => {
    const onClick = vi.fn();
    control("heatmap-btn").addEventListener("click", onClick);
    const release = holdControls(["heatmap-btn"], WHY);

    control("heatmap-btn").click();

    expect(onClick).not.toHaveBeenCalled();
    expect(toastMock.showToast).toHaveBeenCalledWith(REASON);

    release();
    control("heatmap-btn").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("gives each back as it was, an unavailable one unavailable (regression)", () => {
    // The speed layer of a site without timing data came back on
    const release = holdControls(
      ["heatmap-btn", "airspeed-btn", "year-select"],
      WHY,
    );

    release();

    expect(control("heatmap-btn").hasAttribute("aria-disabled")).toBe(false);
    expect(control("airspeed-btn").getAttribute("aria-disabled")).toBe("true");
    expect(control("year-select").disabled).toBe(false);
  });

  it("gives a button the word it got while held", () => {
    // Reset view's own word changes with every camera move
    const release = holdControls(["heatmap-btn", "airspeed-btn"], WHY);

    setUnavailable(control("heatmap-btn"), true);
    setUnavailable(control("airspeed-btn"), false);
    expect(control("heatmap-btn").getAttribute("aria-disabled")).toBe("true");
    expect(control("airspeed-btn").getAttribute("aria-disabled")).toBe("true");

    release();
    expect(control("heatmap-btn").getAttribute("aria-disabled")).toBe("true");
    expect(control("airspeed-btn").getAttribute("aria-disabled")).toBe("false");
  });

  it("says why on each while it holds them, and gives each its title back", () => {
    control("heatmap-btn").title = "Heatmap";
    const release = holdControls(["heatmap-btn", "year-select"], WHY);

    expect(control("heatmap-btn").title).toBe(REASON);
    expect(control("year-select").title).toBe(REASON);

    release();
    expect(control("heatmap-btn").title).toBe("Heatmap");
    expect(control("year-select").title).toBe("");
  });

  it("gives back the title a control was given while held (regression)", () => {
    control("heatmap-btn").title = "Pick one flight";
    const release = holdControls(["heatmap-btn"], WHY);

    // A pick in the statistics rail while the tour runs
    setUnavailable(control("heatmap-btn"), false, "Replay the flight");
    expect(control("heatmap-btn").title).toBe(REASON);

    release();
    expect(control("heatmap-btn").title).toBe("Replay the flight");
    expect(control("heatmap-btn").dataset["heldTitle"]).toBeUndefined();
    expect(control("heatmap-btn").getAttribute("aria-disabled")).toBe("false");
  });

  it("gives them back once", () => {
    const release = holdControls(["heatmap-btn"], WHY);
    release();
    control("heatmap-btn").setAttribute("aria-disabled", "true");

    release();

    expect(control("heatmap-btn").getAttribute("aria-disabled")).toBe("true");
  });

  describe("two modes at once", () => {
    const TOUR = "End the hotspot tour to change this";

    it("speaks for the later, and goes back to the earlier as it ends", () => {
      const tour = holdControls(
        ["heatmap-btn", "year-select"],
        "the hotspot tour",
      );
      const replay = holdControls(["heatmap-btn"], WHY);
      const heatmap = control("heatmap-btn");

      // One element per hold, never one id twice
      const ids = [...document.querySelectorAll('[id^="held-reason"]')].map(
        (reason) => reason.id,
      );
      expect(new Set(ids).size).toBe(2);
      expect(heldReason(heatmap)).toBe(REASON);
      expect(
        document.getElementById(heatmap.getAttribute("aria-describedby")!)
          ?.textContent,
      ).toBe(REASON);

      replay();
      // Still held, by the tour, which a click names
      expect(heatmap.getAttribute("aria-disabled")).toBe("true");
      expect(heldReason(heatmap)).toBe(TOUR);
      heatmap.click();
      expect(toastMock.showToast).toHaveBeenLastCalledWith(TOUR);

      tour();
      expect(heldReason(heatmap)).toBeNull();
      expect(heatmap.hasAttribute("aria-disabled")).toBe(false);
      expect(control("year-select").disabled).toBe(false);
    });

    it("lets a click through once the last hold ends", () => {
      const onClick = vi.fn();
      control("heatmap-btn").addEventListener("click", onClick);
      const tour = holdControls(["heatmap-btn"], "the hotspot tour");
      const replay = holdControls(["year-select"], WHY);

      tour();
      control("heatmap-btn").click();
      replay();

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });
  });

  it("ends with the app's lifetime", () => {
    const lifetime = new AbortController();
    holdControls(["heatmap-btn", "year-select"], WHY, lifetime.signal);

    lifetime.abort();

    expect(control("heatmap-btn").hasAttribute("aria-disabled")).toBe(false);
    expect(control("year-select").disabled).toBe(false);
    control("heatmap-btn").click();
    expect(toastMock.showToast).not.toHaveBeenCalled();
    // Already over: nothing is held at all
    holdControls(["heatmap-btn"], WHY, lifetime.signal);
    expect(heldReason(control("heatmap-btn"))).toBeNull();
  });

  it("has a replay hold every control of the selection, from the list the tour holds as well", () => {
    // Two copies of the chip's buttons had to be kept alike
    expect(REPLAY_HELD_CONTROL_IDS).toEqual(
      expect.arrayContaining([...SELECTION_CONTROL_IDS]),
    );
    expect(SELECTION_CONTROL_IDS).toEqual([
      "isolate-btn",
      "selection-clear-btn",
      "selection-share-btn",
      "selection-exit-btn",
    ]);
  });
});
