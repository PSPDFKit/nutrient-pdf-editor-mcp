/**
 * Helper to assert that a value is plain JSON (no Immutable collections, class instances, or blob URLs)
 * AC9.1: ensures API boundaries don't leak SDK-internal types or browser-specific URLs
 */

/**
 * Recursively walk a value and assert it's plain JSON-safe.
 * Throws if:
 * - Value is an Immutable.List or Immutable.Map
 * - Value is a class instance (not plain object/array)
 * - String value is a blob: or http(s): URL
 *
 * @param obj The value to check
 * @param path Optional path for error messages (e.g. "result.annotations[0].rect")
 * @throws Error if any constraint is violated
 */
export function assertPlainJson(obj: unknown, path: string = "root"): void {
  // Handle null/undefined
  if (obj === null || obj === undefined) {
    return;
  }

  // Check for Immutable collections by constructor name
  const constructor = Object.getPrototypeOf(obj)?.constructor?.name || "";
  if (constructor === "List" || constructor === "Map") {
    throw new Error(
      `[${path}] Found Immutable.${constructor} (not plain JSON). ` +
      `Viewer must convert SDK collections to plain arrays/objects before crossing bridge.`
    );
  }

  // Check if it's a plain object (not a class instance)
  if (typeof obj === "object") {
    const proto = Object.getPrototypeOf(obj);

    // Allow plain objects, arrays, and null prototype objects
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
      // It's a class instance
      const className = proto?.constructor?.name || "Unknown";
      throw new Error(
        `[${path}] Found class instance of ${className} (not plain JSON). ` +
        `Only plain objects/arrays are allowed at API boundaries.`
      );
    }

    // Recursively check array elements
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        assertPlainJson(obj[i], `${path}[${i}]`);
      }
    } else {
      // Recursively check object properties
      for (const key of Object.keys(obj)) {
        assertPlainJson((obj as Record<string, unknown>)[key], `${path}.${key}`);
      }
    }
  } else if (typeof obj === "string") {
    // Check string values for blob: or http(s): URLs
    if (obj.startsWith("blob:")) {
      throw new Error(
        `[${path}] Found blob: URL. Blob URLs are browser-internal and should not cross the API boundary.`
      );
    }

    if (obj.startsWith("http://") || obj.startsWith("https://")) {
      throw new Error(
        `[${path}] Found http(s): URL in response. ` +
        `Only relative paths are allowed.`
      );
    }
  }
}
