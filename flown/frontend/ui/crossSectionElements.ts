/**
 * Cross-section elements - what the panel and its chart are built of
 *
 * The cross-section's panel (ui/crossSection.ts) and its chart
 * (ui/crossSectionChart.ts) are built in code, as the tool first opens,
 * from a handful of kinds of element: plain ones with a class, the shapes
 * of the chart's SVG, buttons whose name is the same to the eye and the
 * ear, and the selects of the corridor's width and of the heights. Each is
 * appended to the parent it is given, so the order they are made in is the
 * order they are read in. The flight profile (ui/flightProfile.ts) is
 * built of the same elements and shapes.
 */
import { setControlIcon, type IconName } from "../utils/icons";

/** An element with a class, in `parent` */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Element,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent.append(el);
  return el;
}

/** A shape of the chart, with a class */
export function shape(
  tag: string,
  className: string,
  parent: Element,
): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  el.setAttribute("class", className);
  parent.append(el);
  return el;
}

/**
 * Name an icon-only button the same to the eye and the ear; the panels of
 * the tour and of the replay of all flights name theirs alike
 */
export function nameButton(button: HTMLElement, name: string): void {
  button.title = name;
  button.setAttribute("aria-label", name);
}

/** A button named the same to the eye and the ear */
export function button(
  className: string,
  name: string,
  parent: Element,
  iconName?: IconName,
): HTMLButtonElement {
  const el = element("button", className, parent);
  el.type = "button";
  nameButton(el, name);
  if (iconName) setControlIcon(el, iconName, 16);
  return el;
}

/** A select of `options`, `[value, label]` */
export function select(
  name: string,
  options: readonly (readonly [string, string])[],
  parent: Element,
): HTMLSelectElement {
  const el = element("select", "btn-surface section-select", parent);
  el.setAttribute("aria-label", name);
  el.title = name;
  for (const [value, label] of options) {
    el.append(new Option(label, value));
  }
  return el;
}
