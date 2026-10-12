/**
 * DOM Element Cache
 * Caches frequently accessed DOM elements to avoid repeated queries
 * Improves performance by reducing DOM lookups
 */

export class DOMCache {
  private cache: Map<string, HTMLElement> = new Map();

  /**
   * Get element by ID, using cache if available
   * @param id - Element ID
   * @param ctor - When given, the element is returned only if it is an
   *   instance of this class (a select, a button); anything else is null
   * @returns Cached or newly queried element, or null if not found
   */
  get(id: string): HTMLElement | null;
  get<T extends HTMLElement>(
    id: string,
    ctor: new (...args: never[]) => T,
  ): T | null;
  get<T extends HTMLElement>(
    id: string,
    ctor?: new (...args: never[]) => T,
  ): HTMLElement | T | null {
    const element = this.lookup(id);
    if (!ctor) return element;
    return element instanceof ctor ? element : null;
  }

  private lookup(id: string): HTMLElement | null {
    if (this.cache.has(id)) {
      const cached = this.cache.get(id)!;
      // Verify element is still in document (not detached)
      if (document.contains(cached)) {
        return cached;
      }
      // Element was removed from DOM, invalidate cache
      this.cache.delete(id);
    }

    const element = document.getElementById(id);
    if (element) {
      this.cache.set(id, element);
    }
    return element;
  }
}

// Export singleton instance for global use
export const domCache = new DOMCache();
