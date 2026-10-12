/**
 * Markup that escapes what it is given, in one place: the facts of Wrapped
 * (features/wrapped.ts) are written as markup, with their figures in
 * <strong>, and carry values of the data in it, such as a registration or
 * an airport's name. Escaped by each producer, one value left unescaped
 * would have been markup of the data's; made with `markup`, a value is
 * escaped unless it is markup made the same way. Not called `html`, which
 * Prettier takes for a template of HTML and wraps, spaces and all.
 */
import { escapeHtml } from "./htmlGenerators";

declare const made: unique symbol;

/** Markup made by `markup`, which nothing else can make */
export type Markup = { readonly html: string } & { readonly [made]: true };

/**
 * Markup of a template literal: its text as written, each value escaped,
 * and markup made by this function as it is
 */
export function markup(
  strings: TemplateStringsArray,
  ...values: (string | number | Markup)[]
): Markup {
  let text = strings[0]!;
  values.forEach((value, i) => {
    text +=
      (typeof value === "object" ? value.html : escapeHtml(String(value))) +
      strings[i + 1]!;
  });
  return { html: text } as Markup;
}
