/**
 * Window-global helpers: typed accessors for values injected by the server
 * into the iframe's HTML at resource-read time.
 *
 * readWindowGlobal<T> is a generic helper that centralises all
 * window-global reads through a single, safe access path instead of
 * ad-hoc casts scattered through the file.
 *
 * IMPORTANT: Do not import node:* — this file is part of the browser bundle.
 */

/**
 * Safely read a value from the browser window object that was injected by the
 * server at resource-read time. Returns `undefined` in non-browser environments
 * (e.g. test runners that simulate a Node-like environment).
 */
export function readWindowGlobal<T>(key: string): T | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, T | undefined>)[key];
}

/**
 * Set by the server at resource-read time (see src/mcp/app-resource.ts) to
 * the version-pinned Nutrient CDN URL. The fallback is a sentinel for unit
 * tests that exercise the missing-global path; the e2e harness sets the
 * real value before any SDK load attempt.
 */
export const ASSET_BASE_URL: string =
  readWindowGlobal<string>("__NUTRIENT_ASSET_BASE__") ?? "http://127.0.0.1:3002/";

/**
 * Host identifier resolved server-side from MCP `clientInfo` and injected
 * into the iframe HTML. When set, passed as `appName` to
 * `NutrientSDK.load()`. Undefined / null / empty → omit `appName`.
 */
export function getAppName(): string | undefined {
  const name = readWindowGlobal<string | null>("__NUTRIENT_APP_NAME__");
  return name || undefined;
}

/**
 * Nutrient Web SDK license key — injected at build time from the
 * VITE_NUTRIENT_LICENSE_KEY env var (typically loaded from a gitignored
 * `.env`). When unset (local dev without a license), the SDK runs in trial
 * mode. The e2e harness sets `window.__NUTRIENT_LICENSE_KEY__ = ""` to
 * force trial mode regardless of the build-time key.
 */
function resolveLicenseKey(): string | undefined {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __NUTRIENT_LICENSE_KEY__?: string };
    if ("__NUTRIENT_LICENSE_KEY__" in w) {
      // Override present — honor it even if empty (forces trial mode).
      return w.__NUTRIENT_LICENSE_KEY__ || undefined;
    }
  }
  return import.meta.env.VITE_NUTRIENT_LICENSE_KEY || undefined;
}
export const NUTRIENT_LICENSE_KEY: string | undefined = resolveLicenseKey();

// Must match DEFAULT_RENEWAL_URL in src/mcp/app-resource.ts.
const DEFAULT_RENEWAL_URL_FALLBACK = "https://nutrient.io/claude-desktop";

/**
 * Resolves the renewal URL from window.__NUTRIENT_RENEWAL_URL__ if set and
 * non-empty, falling back to an embedded default when the global is not set
 * (dev/E2E without server injection). Treats empty strings as unset.
 */
export function getRenewalUrlFromWindow(): string {
  const value = readWindowGlobal<string>("__NUTRIENT_RENEWAL_URL__");
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return DEFAULT_RENEWAL_URL_FALLBACK;
}

/**
 * Update notice injected by the server when a newer release exists (see
 * src/mcp/update-check.ts → src/mcp/app-resource.ts). Mirrors the server's
 * `UpdateInfo` shape; kept as a local type so the browser bundle does not
 * import from src/mcp/ (enforced by the no-restricted-imports rule).
 */
export interface ViewerUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
}

/**
 * Reads window.__NUTRIENT_UPDATE__ — present only when the server's runtime
 * update check found a newer release. Returns `undefined` when this bundle is
 * current or the check did not run / failed. Validates the shape defensively
 * so a malformed injection can never crash the toast renderer.
 */
export function getUpdateInfoFromWindow(): ViewerUpdateInfo | undefined {
  const value = readWindowGlobal<unknown>("__NUTRIENT_UPDATE__");
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.currentVersion === "string" &&
    typeof v.latestVersion === "string" &&
    typeof v.downloadUrl === "string"
  ) {
    return {
      currentVersion: v.currentVersion,
      latestVersion: v.latestVersion,
      downloadUrl: v.downloadUrl
    };
  }
  return undefined;
}
