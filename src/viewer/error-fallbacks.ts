/**
 * DOM error fallbacks and server-side error forwarding for the viewer iframe.
 *
 * Contains:
 * - renderUnloadedDocumentMessage: placeholder DOM rendered when the iframe
 *   is rehydrated from a prior conversation with no active document.
 * - renderExpiredLicenseOverlay: license-expiry overlay with a renewal link.
 * - submitLicenseError: forwards license errors to the MCP server via bridge.
 * - submitViewerError: forwards generic SDK errors to the MCP server.
 *
 * IMPORTANT: Do not import node:* — this file is part of the browser bundle.
 */

import type { App } from "@modelcontextprotocol/ext-apps";
import {
  LICENSE_ERROR_CODE,
  buildGuidance,
  type LicenseErrorSubKind,
  type ViewerErrorPayload
} from "../contract/viewer-errors.js";
import { getRenewalUrlFromWindow } from "./window-globals.js";

/**
 * Renders an explanatory message into `#viewer` when the iframe was restored
 * from a prior conversation but the new server's session is empty (no
 * `open_document` has run yet, or filesystem roots haven't been advertised by
 * the host). Skips rendering if the SDK is already mounted.
 */
export function renderUnloadedDocumentMessage(documentPath: string): void {
  if (typeof document === "undefined") return;
  const viewerEl = document.getElementById("viewer");
  if (!viewerEl) return;
  // Never clobber a working view. The querySelector guard is defensive — callers
  // are expected to invoke this only when no SDK instance is active. Guarded
  // with a typeof check so test-mocks that omit querySelector don't throw.
  if (
    typeof viewerEl.querySelector === "function" &&
    viewerEl.querySelector("canvas, .PSPDFKit-Document")
  )
    return;

  const filename = documentPath.split("/").pop() || "this document";

  viewerEl.replaceChildren();
  viewerEl.removeAttribute("data-state");
  const container = document.createElement("div");
  container.className = "nutrient-viewer-fallback";

  const heading = document.createElement("h2");
  heading.textContent = "Reopen the document to continue";

  // Phrasing is host-agnostic: this MCP runs under any compliant client. We
  // could switch on `clientInfo.name` to display a host-specific noun, but
  // that requires a brittle mapping table and an unknown-client fallback.
  // "your assistant" reads naturally everywhere.
  const body = document.createElement("p");
  body.appendChild(
    document.createTextNode(
      "This view was restored from an earlier session, but the document " +
        "isn't loaded yet. Ask your assistant to open "
    )
  );
  const code = document.createElement("code");
  code.textContent = filename;
  body.appendChild(code);
  body.appendChild(document.createTextNode(" again to continue."));

  container.appendChild(heading);
  container.appendChild(body);
  viewerEl.appendChild(container);
}

/**
 * Renders an expired license overlay into `#viewer` when the SDK rejects
 * with an expired license. Shows a heading and a paragraph with a clickable
 * renewal URL. Idempotent — if the overlay is already present, does nothing.
 */
export function renderExpiredLicenseOverlay(renewalUrl: string, app: App): void {
  if (typeof document === "undefined") return;
  const viewerEl = document.getElementById("viewer");
  if (!viewerEl) return;

  // Idempotence guard: if the overlay is already present, don't render again.
  for (let i = 0; i < viewerEl.children.length; i++) {
    const child = viewerEl.children[i];
    if (child instanceof Element && child.classList.contains("nutrient-license-expired-overlay")) {
      return;
    }
  }

  viewerEl.replaceChildren();
  viewerEl.removeAttribute("data-state");
  const container = document.createElement("div");
  container.classList.add("nutrient-viewer-fallback");
  container.classList.add("nutrient-license-expired-overlay");

  const heading = document.createElement("h2");
  heading.textContent = "Nutrient PDF Editor needs updating";

  const body = document.createElement("p");
  body.appendChild(document.createTextNode("Please check the marketplace for updates or visit "));
  const link = document.createElement("a");
  link.href = renewalUrl;
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = renewalUrl;
  // Inside the host iframe, target="_blank" is intercepted by the embedder and
  // the new window typically never opens (cmd+click is the only path that
  // works because that bypasses the iframe). When the host advertises the
  // openLinks capability, route through `app.openLink` so the URL opens in
  // the user's default browser. Fall back to default anchor behavior when the
  // capability is missing (e.g. dev/E2E without a connected host).
  link.addEventListener("click", (event) => {
    if (!app.getHostCapabilities()?.openLinks) return;
    event.preventDefault();
    void app.openLink({ url: renewalUrl }).catch((err) => {
      console.warn("[nutrient-viewer] openLink failed", err);
    });
  });
  body.appendChild(link);
  body.appendChild(document.createTextNode(" for more information."));

  container.appendChild(heading);
  container.appendChild(body);
  viewerEl.appendChild(container);
}

/**
 * Forward a license error to the MCP server via the viewer_event internal
 * tool. Uses a typed discriminated union — no sentinel requestId needed.
 *
 * Uses a dedicated viewer_event tool call so submit_response is
 * single-purpose (responses to queued commands only).
 *
 * NEVER includes the license key value in the payload.
 */
export async function submitLicenseError(subKind: LicenseErrorSubKind, app: App): Promise<void> {
  const event = {
    type: "license_error" as const,
    payload: {
      code: LICENSE_ERROR_CODE,
      subKind,
      guidance: buildGuidance(subKind, getRenewalUrlFromWindow())
    }
  };
  try {
    await app.callServerTool({
      name: "viewer_event",
      arguments: { event }
    });
  } catch (err) {
    // Best-effort: if the bridge is not yet up or the server is not reachable,
    // log the failure but don't mask the original license error.
    console.error("[nutrient-viewer] submitLicenseError failed:", err);
  }
}

/**
 * Forward a generic (non-license) viewer error to the MCP server via the
 * viewer_event internal tool. Used when the originating tool call has already
 * returned (no requestId to fail).
 *
 * Uses a dedicated viewer_event tool call instead of a sentinel requestId.
 */
export async function submitViewerError(
  message: string,
  source: ViewerErrorPayload["source"],
  app: App
): Promise<void> {
  const event = {
    type: "viewer_error" as const,
    payload: { message, source }
  };
  try {
    await app.callServerTool({
      name: "viewer_event",
      arguments: { event }
    });
  } catch (err) {
    console.error("[nutrient-viewer] submitViewerError failed:", err);
  }
}
