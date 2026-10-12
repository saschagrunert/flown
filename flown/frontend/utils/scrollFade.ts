/**
 * Mark a scroll container that has reached its end.
 *
 * Long panels are cut off wherever the container stops, which lands
 * mid-row as often as not and reads as content hidden behind whatever sits
 * below. The stylesheet fades the last few pixels of such a panel to say
 * there is more; the fade would then sit over the final row forever, so the
 * container carries `is-at-end` once it is scrolled to the bottom (or never
 * scrolls at all) and the stylesheet drops the fade again.
 *
 * The position is re-read on scroll, on a window resize and on any resize of
 * the container itself; `update` stays exported for a caller that rewrites
 * the content without changing its size.
 */

/** Handle on a watched container */
export interface ScrollEndWatcher {
  /**
   * Re-read the scroll position. Scrolling and resizing are followed on
   * their own; a panel whose content was just rewritten has to say so, as
   * neither event fires for that.
   */
  update: () => void;
  /** Stop watching */
  stop: () => void;
}

/**
 * Watch `element` and keep its `is-at-end` class in step with its scroll
 * position.
 */
export function watchScrollEnd(element: HTMLElement): ScrollEndWatcher {
  const update = (): void => {
    const atEnd =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    element.classList.toggle("is-at-end", atEnd);
  };

  element.addEventListener("scroll", update, { passive: true });
  // A resize can make everything fit, and then the fade would sit over
  // nothing until the next scroll that can no longer happen
  window.addEventListener("resize", update, { passive: true });

  // The window is not the only thing that changes the measurement. Opening
  // the statistics rail compacts the control columns without the viewport
  // moving at all, and the column was left claiming it had reached its end
  // while it had just started to overflow. Watching the element covers every
  // such case, including the ones a caller would have to remember to report.
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  observer?.observe(element);

  update();

  return {
    update,
    stop: () => {
      element.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    },
  };
}
