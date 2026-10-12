/**
 * A yes or no the browser keeps for the page in its localStorage, such as
 * whether the flight profile was put away. The storage may be unavailable
 * (a private window, blocked site data): the flag then reads as no, and a
 * change is kept by the caller for the page's lifetime only.
 */

/** Whether the flag under `key` is set */
export function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Set the flag under `key`, or clear it */
export function storeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Unavailable storage: the caller keeps it for the page's lifetime
  }
}
