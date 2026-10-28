/**
 * Text made safe to insert as HTML, in an element or in a quoted
 * attribute: the one escape of the page's markup, wherever names, files
 * or answers of a server go into it (markup`` among them)
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
