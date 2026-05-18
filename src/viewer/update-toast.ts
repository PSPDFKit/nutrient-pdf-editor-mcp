/**
 * Temporary "an update is available" popover, rendered top-right of the
 * viewer iframe when the server's runtime update check (src/mcp/update-check.ts)
 * found a newer release.
 *
 * The toast auto-dismisses after AUTO_DISMISS_MS, can be closed manually, and
 * carries a download link that routes through `app.openLink` so it opens in
 * the user's real browser rather than being swallowed by the host iframe —
 * the same pattern as the license-expiry overlay in error-fallbacks.ts.
 *
 * IMPORTANT: Do not import node:* — this file is part of the browser bundle.
 */

import type { App } from "@modelcontextprotocol/ext-apps";
import type { ViewerUpdateInfo } from "./window-globals.js";

const TOAST_CLASS = "nutrient-update-toast";
/** Auto-dismiss after 12s — long enough to read, short enough not to nag. */
const AUTO_DISMISS_MS = 12_000;
/** Matches the CSS fade-out transition duration in index.html. */
const FADE_OUT_MS = 300;

function dismiss(toast: HTMLElement): void {
  toast.classList.add("is-leaving");
  setTimeout(() => toast.remove(), FADE_OUT_MS);
}

/**
 * Render the update toast into `document.body`. Idempotent — a second call
 * while a toast is already present is a no-op, so reconnects don't stack
 * popovers.
 */
export function renderUpdateToast(info: ViewerUpdateInfo, app: App): void {
  if (typeof document === "undefined" || !document.body) return;
  if (document.querySelector(`.${TOAST_CLASS}`)) return;

  const toast = document.createElement("div");
  toast.className = TOAST_CLASS;
  toast.setAttribute("role", "status");

  const heading = document.createElement("h3");
  heading.textContent = "Update available";

  const body = document.createElement("p");
  body.textContent =
    `You're on version ${info.currentVersion}. Version ` +
    `${info.latestVersion} is available — download the latest to get the ` +
    `newest features and fixes.`;

  const link = document.createElement("a");
  link.className = `${TOAST_CLASS}-link`;
  link.href = info.downloadUrl;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = "Get the latest version";
  // Inside the host iframe, target="_blank" is intercepted and the new window
  // typically never opens. When the host advertises openLinks, route through
  // app.openLink; otherwise fall back to default anchor behavior (dev/E2E).
  link.addEventListener("click", (event) => {
    if (!app.getHostCapabilities()?.openLinks) return;
    event.preventDefault();
    void app.openLink({ url: info.downloadUrl }).catch((err) => {
      console.warn("[nutrient-viewer] openLink failed", err);
    });
  });

  const close = document.createElement("button");
  close.type = "button";
  close.className = `${TOAST_CLASS}-close`;
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => dismiss(toast));

  toast.appendChild(close);
  toast.appendChild(heading);
  toast.appendChild(body);
  toast.appendChild(link);
  document.body.appendChild(toast);

  setTimeout(() => {
    if (toast.isConnected) dismiss(toast);
  }, AUTO_DISMISS_MS);
}
