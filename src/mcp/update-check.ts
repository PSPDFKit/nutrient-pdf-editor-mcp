/**
 * Runtime update check. On server startup we fire a single bounded request to
 * the GitHub releases API, compare the latest published release against this
 * bundle's own version, and — if a newer one exists — surface a download
 * prompt to the user via a toast in the viewer iframe (see
 * src/viewer/update-toast.ts).
 *
 * A GitHub Actions check cannot see what version a user has installed in
 * Claude Desktop, so the staleness comparison has to happen here, at runtime.
 *
 * Fail-open by design: the check never throws and never blocks startup. Any
 * failure (offline, 404, rate-limit, malformed JSON) resolves to `null` and
 * the user simply sees no notice.
 */
import { log } from "./logger.js";

/** Where the user is told to go to get the latest build. */
export const DOWNLOAD_URL = "https://nutrient.io/claude-desktop";

/**
 * GitHub releases API for the public distribution repo. The `-internal` repo
 * builds the .mcpb; releases are published on the public mirror.
 */
const LATEST_RELEASE_API =
  "https://api.github.com/repos/PSPDFKit/nutrient-pdf-editor-mcp/releases/latest";

/** Bound the request so a hung connection can't delay the first viewer mount. */
const FETCH_TIMEOUT_MS = 5_000;

/**
 * This bundle's version, inlined at build time by esbuild `define` (see
 * scripts/build-server.mjs). The fallback is only hit in unit tests, which
 * import this module without the build-time substitution.
 */
function getOwnVersion(): string {
  const injected = (globalThis as { __NUTRIENT_MCPB_VERSION__?: string }).__NUTRIENT_MCPB_VERSION__;
  return injected ?? "0.0.0";
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
}

/**
 * Parse `x.y.z` (optionally `v`-prefixed, optionally with a `-prerelease`
 * suffix) into a numeric triple. Returns `null` when the string has no
 * recognisable numeric core — callers treat that as "cannot compare".
 */
export function parseVersion(raw: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string | null> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) {
    log("info", "update.check.skipped", { reason: `http ${res.status}` });
    return null;
  }
  const body = (await res.json()) as { tag_name?: unknown };
  return typeof body.tag_name === "string" ? body.tag_name : null;
}

/**
 * Module-level cache so the network round-trip happens exactly once per
 * process. `startUpdateCheck` kicks it off at startup; `getUpdateInfo` awaits
 * the same promise when the viewer resource is read.
 */
let updateCheck: Promise<UpdateInfo | null> | null = null;

async function runUpdateCheck(): Promise<UpdateInfo | null> {
  const currentVersion = getOwnVersion();
  try {
    const tag = await fetchLatestVersion();
    if (!tag || !isNewerVersion(tag, currentVersion)) return null;
    const latestVersion = tag.replace(/^v/, "");
    log("info", "update.available", { currentVersion, latestVersion });
    return { currentVersion, latestVersion, downloadUrl: DOWNLOAD_URL };
  } catch (err) {
    log("info", "update.check.failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/** Fire-and-forget: start the check at server startup. Idempotent. */
export function startUpdateCheck(): void {
  updateCheck ??= runUpdateCheck();
}

/**
 * Resolve the update result, awaiting the in-flight check if needed. Bounded
 * by FETCH_TIMEOUT_MS via the fetch's own AbortSignal, so awaiting this in the
 * (async) viewer-resource handler can never hang the iframe mount.
 */
export async function getUpdateInfo(): Promise<UpdateInfo | null> {
  updateCheck ??= runUpdateCheck();
  return updateCheck;
}

/** Test-only: drop the cached result so each case starts clean. */
export function __resetUpdateCheckForTesting(): void {
  updateCheck = null;
}
