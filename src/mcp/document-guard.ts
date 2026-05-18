import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { hasOpenDocument, isDocumentDirty, getLicenseError } from "./session.js";
import { buildGuidance } from "../contract/viewer-errors.js";
import { getRenewalUrl } from "./app-resource.js";

export const NO_DOCUMENT_OPEN_MESSAGE = "No document is currently open. Call open_document first.";

export const DOCUMENT_STALE_MESSAGE =
  "Document on disk has changed since it was opened. Call close_document and open_document again to reload the latest version.";

/**
 * Throws McpError with data.code === "LICENSE_ERROR" if the viewer reported
 * a license failure during the most recent SDK load. The error data also
 * carries the sub-kind and user-facing guidance text.
 *
 * Called as the first guard in every public tool so subsequent tool calls
 * fail fast without reaching the viewer.
 *
 * The MCP SDK's McpError constructor takes (code, message, data?). We pass
 * a structured `data` object so the model can distinguish this error
 * programmatically via `error.data.code === "LICENSE_ERROR"`.
 */
export function requireValidLicense(): void {
  const licenseError = getLicenseError();
  if (licenseError) {
    // The structured data field still carries code: "LICENSE_ERROR" — programmatic consumers should key off error.data.code, not the message string.
    throw new McpError(
      ErrorCode.InvalidParams,
      buildGuidance(licenseError.subKind, getRenewalUrl()),
      licenseError
    );
  }
}

export function requireOpenDocument(): void {
  if (hasOpenDocument()) return;
  throw new McpError(ErrorCode.InvalidParams, NO_DOCUMENT_OPEN_MESSAGE);
}

/**
 * Companion to `requireOpenDocument`. Throws if the staleness watcher (or the
 * write-side pre-rename stat-compare) has flagged the open document as having
 * been edited externally since `open_document`. Every operating-tool handler
 * calls this as the second statement after `requireOpenDocument()`. The
 * remedy is `close_document` + `open_document`: by user direction we do not
 * merge external edits and we do not live-reload the iframe.
 */
export function requireFreshDocument(): void {
  if (isDocumentDirty()) {
    throw new McpError(ErrorCode.InvalidParams, DOCUMENT_STALE_MESSAGE);
  }
}
