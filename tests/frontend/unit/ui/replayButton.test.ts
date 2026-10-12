/**
 * The replay control's resting state.
 *
 * It has to explain itself from the first paint, before anyone opens replay
 * and the feature bundle is fetched, so the app drives it and not the replay
 * manager. These tests cover the part that stays in the main bundle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  REPLAY_BUTTON_LABEL,
  REPLAY_PRECONDITION_MESSAGE,
  updateReplayButtonState,
} from "../../../../flown/frontend/ui/replayButton";

function button(): HTMLButtonElement {
  return document.getElementById("replay-btn") as HTMLButtonElement;
}

describe("updateReplayButtonState", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button id="replay-btn" aria-label="Replay selected flights"></button>';
  });

  it("dims the button and says what is missing when replay is not possible", () => {
    updateReplayButtonState(REPLAY_PRECONDITION_MESSAGE);

    // aria-disabled, which the stylesheet dims; no style of its own
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().style.opacity).toBe("");
    expect(button().title).toBe(REPLAY_PRECONDITION_MESSAGE);
  });

  it("brings it to full strength once replay is possible", () => {
    updateReplayButtonState(null);

    expect(button().getAttribute("aria-disabled")).toBe("false");
    expect(button().style.opacity).toBe("");
    expect(button().title).toBe(REPLAY_BUTTON_LABEL);
  });

  it("leaves the button clickable either way", () => {
    // Clicking it is how the user learns why replay is unavailable, so it
    // must not be disabled: aria-disabled says so and keeps it focusable
    updateReplayButtonState(REPLAY_PRECONDITION_MESSAGE);

    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-disabled")).toBe("true");

    updateReplayButtonState(null);

    expect(button().getAttribute("aria-disabled")).toBe("false");
  });

  it("does nothing when the control is not on the page", () => {
    document.body.innerHTML = "";

    expect(() => updateReplayButtonState(null)).not.toThrow();
  });
});
