/**
 * Viewer error types and sentinel requestId constants shared between the
 * MCP server (Node target) and the viewer iframe (browser target).
 *
 * MUST NOT import node:* — this file is imported by both targets.
 *
 * These move from src/mcp/license-error.ts and src/mcp/viewer-error.ts as
 * part of the src/contract/ decoupling layer. The originating files
 * re-export from here for backward compatibility.
 */

// ---------------------------------------------------------------------------
// License error types
// ---------------------------------------------------------------------------

/**
 * Stable error code surfaced in McpError.data.code for all license failures.
 */
export const LICENSE_ERROR_CODE = "LICENSE_ERROR";

/**
 * Sub-kinds of license errors.
 */
export type LicenseErrorSubKind = "invalid" | "expired" | "host-mismatch";

/**
 * The structured payload the viewer forwards via the viewer_event internal
 * tool when the SDK rejects with a license-related error.
 *
 * The license key value MUST NOT appear anywhere in this payload.
 */
export interface LicenseErrorPayload {
  /** Always LICENSE_ERROR_CODE ("LICENSE_ERROR"). */
  code: string;
  subKind: LicenseErrorSubKind;
  guidance: string;
}

// ---------------------------------------------------------------------------
// Viewer error types
// ---------------------------------------------------------------------------

/**
 * Payload the viewer forwards via the viewer_event internal tool when a
 * non-license SDK rejection has no outstanding requestId (e.g.
 * NutrientSDK.load() rejects after open_document already returned).
 */
export interface ViewerErrorPayload {
  /** Human-readable error message lifted from the underlying Error. */
  message: string;
  /** Where in the viewer the error originated, for log correlation. */
  source: "load";
}

// ---------------------------------------------------------------------------
// License error utilities (shared between server and viewer)
// ---------------------------------------------------------------------------

/**
 * DWS support contact URL. Duplicated from src/mcp/license-error.ts for use
 * in the viewer bundle (browser target) without importing from src/mcp/.
 */
export const LICENSE_SUPPORT_CONTACT = "https://www.nutrient.io/support/";

/**
 * Build the renewal message for an expired license.
 */
export function buildExpiredRenewalMessage(renewalUrl: string): string {
  return `Nutrient PDF Editor needs updating. Please check the marketplace for updates or visit ${renewalUrl} for more information.`;
}

/**
 * Build the user-facing guidance string for a given sub-kind.
 */
export function buildGuidance(subKind: LicenseErrorSubKind, renewalUrl?: string): string {
  const contact = LICENSE_SUPPORT_CONTACT;
  switch (subKind) {
    case "expired":
      if (renewalUrl && renewalUrl.length > 0) {
        return buildExpiredRenewalMessage(renewalUrl);
      }
      return (
        "The Nutrient Web SDK license has expired. " + `Please renew your license at ${contact}.`
      );
    case "host-mismatch":
      return (
        "The Nutrient Web SDK license is not valid for this host. " +
        `Please contact support at ${contact}.`
      );
    case "invalid":
      return (
        "The Nutrient Web SDK rejected the license configuration. " +
        `Please check your license settings or contact support at ${contact}.`
      );
  }
}

/**
 * Classify a raw error message from NutrientSDK.load() into a LicenseErrorSubKind.
 * Returns null when the message contains no license-related signal.
 */
export function classifyLoadError(message: string): LicenseErrorSubKind | null {
  const lower = message.toLowerCase();
  if (lower.includes("expir")) return "expired";
  if (!lower.includes("license")) return null;
  if (
    lower.includes("domain") ||
    lower.includes("host") ||
    lower.includes("bundle") ||
    lower.includes("origin") ||
    lower.includes("not authorized")
  ) {
    return "host-mismatch";
  }
  return "invalid";
}

// ---------------------------------------------------------------------------
// Sentinel requestId constants
// ---------------------------------------------------------------------------
// Used by the viewer to push unsolicited payloads via submit_response when
// there is no outstanding requestId to attach to. The server recognises these
// sentinels in the submit_response handler and routes them to the appropriate
// state-update path instead of resolving a pending promise.
//
// @deprecated Sentinel requestIds have been superseded by the viewer_event
// internal tool. These constants remain here for backward compat.

/** Sentinel requestId for unsolicited license-error payloads. */
export const LICENSE_ERROR_REQUEST_ID = "__license_error__";

/** Sentinel requestId for unsolicited generic viewer-error payloads. */
export const VIEWER_ERROR_REQUEST_ID = "__viewer_error__";
