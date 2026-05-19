/**
 * Host-context integration for the viewer iframe.
 *
 * Owns the ext-apps App singleton, display-mode preference, and frame-size
 * negotiation. Re-fired from `onhostcontextchanged` so we re-assert size
 * when the host pushes a new context (e.g. Cowork returns to the foreground
 * after being off-screen, or user toggles display-mode via the host UI).
 *
 * Display-mode policy: prefer fullscreen when the host advertises it,
 * otherwise accept the host's pick (typically inline). A document viewer
 * is best experienced edge-to-edge — both Cowork and Claude Desktop
 * advertise fullscreen as available, but Claude Desktop defaults to
 * `inline`, which leaves the document in a 600px conversation card.
 * `preferFullscreenIfAvailable` runs once after `connect` and asks the
 * host to switch; if `availableDisplayModes` doesn't include fullscreen
 * (or the request is rejected), we leave the host's pick alone.
 *
 * Refs:
 *   spec — https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 *   skill — https://github.com/modelcontextprotocol/ext-apps/blob/main/plugins/mcp-apps/skills/add-app-to-server/SKILL.md
 *
 * IMPORTANT: Do not import node:* — this file is part of the browser bundle.
 */

import {
  App,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext
} from "@modelcontextprotocol/ext-apps";

// The ext-apps App singleton. Module-level so all viewer modules share one.
export const app = new App(
  { name: "Nutrient Viewer", version: "0.1.0" },
  { availableDisplayModes: ["fullscreen", "pip", "inline"] },
  { autoResize: false }
);

// Pending mount-gate waiters resolved by `applyHostContext` once the host
// reports non-zero container dimensions. See `awaitNonZeroContainerDimensions`.
const pendingContainerDimWaiters: Array<() => void> = [];

export function hasNonZeroContainerDimensions(ctx: McpUiHostContext | undefined): boolean {
  const dims = ctx?.containerDimensions as { width?: number; height?: number } | undefined;
  // Treat "not advertised" as okay — only block on explicit {0, 0}.
  if (!dims || typeof dims.width !== "number" || typeof dims.height !== "number") return true;
  return dims.width > 0 && dims.height > 0;
}

export async function awaitNonZeroContainerDimensions(): Promise<void> {
  if (hasNonZeroContainerDimensions(app.getHostContext())) return;
  await new Promise<void>((resolve) => {
    pendingContainerDimWaiters.push(resolve);
  });
}

// Most-recently-logged display-mode advertisement, used to suppress
// duplicate prints from the frequent host-context-changed flow.
let lastLoggedDisplayModeLine: string | undefined;

function logDisplayModeAdvertisement(ctx: McpUiHostContext | undefined, source: string): void {
  const host = app.getHostVersion();
  const available = ctx?.availableDisplayModes;
  const current = ctx?.displayMode;
  const line =
    `host=${host?.name ?? "unknown"} v${host?.version ?? "?"} | ` +
    `availableDisplayModes=${available ? JSON.stringify(available) : "(not advertised)"} | ` +
    `displayMode=${current ?? "(not set)"} | ` +
    `fullscreenAdvertised=${available?.includes("fullscreen") ?? false}`;
  if (line === lastLoggedDisplayModeLine) return;
  lastLoggedDisplayModeLine = line;
  console.info(`[nutrient-viewer] display-mode advertisement (${source}): ${line}`);
}

export function applyHostContext(ctx: McpUiHostContext) {
  logDisplayModeAdvertisement(ctx, "host-context-changed");
  // Reflect the host theme onto <html> as `data-theme` — the signal our own
  // chrome (loading state, unloaded-document fallback, update toast) themes
  // off. We set ONLY the attribute, deliberately not `color-scheme`: this
  // iframe is 100% the Nutrient viewer, the SDK themes its own UI from
  // `theme: DARK` (see `nutrientThemeFromHost`), and a document-wide
  // `color-scheme: dark` would flip the inherited `CanvasText` default —
  // which breaks SDK components that inherit their text color (the note
  // popover, whose background is a fixed light pastel, is one). ext-apps'
  // `applyDocumentTheme` sets both attribute and `color-scheme`, so we don't
  // use it.
  if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (hasNonZeroContainerDimensions(ctx) && pendingContainerDimWaiters.length > 0) {
    const waiters = pendingContainerDimWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
  // Re-assert frame size whenever the host context changes (panel becomes
  // active, container dimensions change, etc.). Cowork can deliver a fresh
  // host-context-changed when its tab returns to the foreground; if we
  // negotiated size while Cowork was off-screen, the iframe stays slim until
  // we re-request. negotiateFrameSize is idempotent and self-throttled.
  void negotiateFrameSize();
}

/**
 * Map the host's theme to a Nutrient SDK theme value (the SDK's `Theme` enum
 * members are the string literals `"LIGHT"` / `"DARK"`).
 *
 * The MCP Apps host context theme is a strict `"light" | "dark" | undefined`
 * union. We map it *explicitly* rather than using the SDK's `AUTO`:
 *
 *   - `AUTO` resolves against the OS `prefers-color-scheme` media query.
 *   - `ctx.theme` is the *host app's* theme, which can differ from the OS
 *     (dark Claude on a light macOS, and vice versa).
 *   - `applyHostContext` reflects `ctx.theme` onto `<html data-theme>` for our
 *     own chrome. Driving the SDK theme off the same source keeps them
 *     consistent; `AUTO` would re-introduce a theme desync on the OS axis.
 *
 * `"light"` and `undefined` both map to `LIGHT` (the SDK default).
 *
 * Note: the SDK has no clean runtime theme swap, so this is only consulted at
 * `NutrientSDK.load` time. A later `onhostcontextchanged` theme change still
 * updates `<html data-theme>`, but the SDK chrome keeps its load-time theme
 * until the next document load.
 */
export function nutrientThemeFromHost(
  hostTheme: McpUiHostContext["theme"]
): "LIGHT" | "DARK" {
  return hostTheme === "dark" ? "DARK" : "LIGHT";
}

// Asks the host to switch to fullscreen iff `availableDisplayModes` includes
// it. No-op when the host doesn't advertise fullscreen, when the host has
// already picked it, or when the request fails. Idempotent across the session.
let fullscreenPreferenceAttempted = false;
export async function preferFullscreenIfAvailable(): Promise<void> {
  if (fullscreenPreferenceAttempted) return;
  fullscreenPreferenceAttempted = true;
  const ctx = app.getHostContext();
  const available = ctx?.availableDisplayModes ?? [];
  if (!available.includes("fullscreen")) return;
  if (ctx?.displayMode === "fullscreen") return;
  try {
    await app.requestDisplayMode({ mode: "fullscreen" });
  } catch (err) {
    console.warn("[nutrient-viewer] requestDisplayMode(fullscreen) failed", err);
  }
}

// Inline-mode card height. The host caps inline iframes at `maxHeight`,
// which in Cowork is the conversation-pane scroll extent — too tall for a
// document preview. 600px matches typical embedded-document affordances.
const INLINE_HEIGHT_PX = 600;

// `lastSentWidth` / `lastSentHeight` deduplicate `sendSizeChanged`. The
// host echoes a host-context-changed back when it applies our size hint;
// without dedupe we'd ping-pong forever.
let frameSizeNegotiationInFlight = false;
let lastSentWidth: number | undefined;
let lastSentHeight: number | undefined;

export async function negotiateFrameSize(): Promise<void> {
  if (frameSizeNegotiationInFlight) return;
  frameSizeNegotiationInFlight = true;
  try {
    const ctx = app.getHostContext();
    const dims = ctx?.containerDimensions;
    const pick = (v: unknown): number | undefined =>
      typeof v === "number" && v > 0 ? v : undefined;
    const fixedWidth = pick((dims as { width?: number } | undefined)?.width);
    const maxWidth = pick((dims as { maxWidth?: number } | undefined)?.maxWidth);
    const fixedHeight = pick((dims as { height?: number } | undefined)?.height);
    const maxHeight = pick((dims as { maxHeight?: number } | undefined)?.maxHeight);
    const width = fixedWidth ?? maxWidth ?? window.innerWidth;
    // Honor a fixed `height` from the host whenever advertised. Otherwise, in
    // inline mode, the only signal is `maxHeight` — usually the conversation
    // pane's full scrollable extent. Filling that makes the iframe absurdly
    // tall when the user exits fullscreen, so cap to a sensible card height.
    const isInline = ctx?.displayMode === "inline";
    const height =
      fixedHeight ??
      (isInline
        ? Math.min(INLINE_HEIGHT_PX, maxHeight ?? INLINE_HEIGHT_PX)
        : (maxHeight ?? window.innerHeight));
    if (width === lastSentWidth && height === lastSentHeight) return;
    try {
      await app.sendSizeChanged({ width, height });
      lastSentWidth = width;
      lastSentHeight = height;
    } catch (err) {
      console.warn("[nutrient-viewer] sendSizeChanged failed", err);
    }
  } finally {
    frameSizeNegotiationInFlight = false;
  }
}

/**
 * Test-only: reset module-level state so tests that import from this module
 * don't see state leakage between test cases.
 */
export function __resetHostContextForTesting(): void {
  fullscreenPreferenceAttempted = false;
  frameSizeNegotiationInFlight = false;
  lastSentWidth = undefined;
  lastSentHeight = undefined;
  lastLoggedDisplayModeLine = undefined;
  pendingContainerDimWaiters.splice(0);
}
