/**
 * Tests for the LICENSE_ERROR propagation pipeline on the MCP server side.
 *
 * Covers:
 * - classifyLoadError heuristic (sub-kind classification from message strings)
 * - buildGuidance (guidance strings contain contact path; never contain key value)
 * - requireValidLicense guard (throws McpError with structured data)
 * - session license state lifecycle (persist, clear on open/close)
 * - submit_response sentinel handling (LICENSE_ERROR_REQUEST_ID intercept)
 * - Tool short-circuit via requireValidLicense (via document-guard)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  classifyLoadError,
  buildGuidance,
  buildExpiredRenewalMessage,
  LICENSE_ERROR_CODE,
  LICENSE_ERROR_REQUEST_ID,
  LICENSE_SUPPORT_CONTACT,
  type LicenseErrorSubKind,
} from "../../src/contract/viewer-errors.js";
import {
  requireValidLicense,
} from "../../src/mcp/document-guard.js";
import {
  setLicenseError,
  clearLicenseError,
  getLicenseError,
  setOpenDocument,
  clearOpenDocument,
  __resetForTesting,
} from "../../src/mcp/session.js";

// ---------------------------------------------------------------------------
// A fake license key used in tests — must never appear in error output.
// Using a realistic-looking but entirely fabricated value.
// ---------------------------------------------------------------------------
const FAKE_LICENSE_KEY = "FAKE-LICENSE-KEY-MUST-NOT-APPEAR-IN-OUTPUT-00000000";

// ---------------------------------------------------------------------------
// classifyLoadError
// ---------------------------------------------------------------------------
describe("classifyLoadError", () => {
  const cases: Array<[string, LicenseErrorSubKind]> = [
    // expired (matches on "expir" alone — license context implied by the
    // SDK's exclusive use of expiry wording in license errors)
    ["The license has expired.", "expired"],
    ["Your license key is expired.", "expired"],
    ["License EXPIRY date passed", "expired"],
    // host-mismatch (must include "license" plus a host/domain/bundle/origin
    // signal, so generic "host"/"origin" wording from non-license errors
    // doesn't get misclassified)
    ["Invalid domain for this license key.", "host-mismatch"],
    ["License: host not authorized.", "host-mismatch"],
    ["License bundle identifier mismatch.", "host-mismatch"],
    ["Origin not covered by this license.", "host-mismatch"],
    ["This host is not authorized for the license.", "host-mismatch"],
    // invalid (license context, no host/expiry signal)
    ["Error while validating license.", "invalid"],
    ["Unknown license error.", "invalid"],
    ["License key is malformed.", "invalid"],
  ];

  for (const [message, expectedKind] of cases) {
    it(`classifies "${message.slice(0, 50)}" → "${expectedKind}"`, () => {
      expect(classifyLoadError(message)).toBe(expectedKind);
    });
  }

  it("classifies case-insensitively (EXPIR → expired)", () => {
    expect(classifyLoadError("LICENSE HAS EXPIRED")).toBe("expired");
  });

  it("classifies case-insensitively (DOMAIN → host-mismatch)", () => {
    expect(classifyLoadError("LICENSE DOMAIN NOT ALLOWED")).toBe("host-mismatch");
  });

  // Non-license errors must return null so the caller re-throws untouched.
  const nonLicenseCases: string[] = [
    "",
    "Failed to fetch document bytes.",
    "Container element not found.",
    "Network request failed.",
    "Invalid PDF structure.",
  ];
  for (const message of nonLicenseCases) {
    it(`returns null for non-license message "${message.slice(0, 50)}"`, () => {
      expect(classifyLoadError(message)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// buildExpiredRenewalMessage
// ---------------------------------------------------------------------------
describe("buildExpiredRenewalMessage", () => {
  it("returns the canonical renewal-message copy with the URL interpolated", () => {
    const result = buildExpiredRenewalMessage("https://example.com/renew");
    expect(result).toBe(
      "Nutrient PDF Editor needs updating. Please check the marketplace for updates or visit https://example.com/renew for more information."
    );
  });
});

// ---------------------------------------------------------------------------
// buildGuidance — must reference the support contact; must NOT contain any
// license key fixture value.
// ---------------------------------------------------------------------------
describe("buildGuidance", () => {
  const subKinds: LicenseErrorSubKind[] = [
    "expired",
    "host-mismatch",
    "invalid",
  ];

  for (const subKind of subKinds) {
    it(`${subKind}: contains the support contact URL`, () => {
      const guidance = buildGuidance(subKind);
      expect(guidance).toContain(LICENSE_SUPPORT_CONTACT);
    });

    it(`${subKind}: is a non-empty string`, () => {
      const guidance = buildGuidance(subKind);
      expect(typeof guidance).toBe("string");
      expect(guidance.length).toBeGreaterThan(0);
    });

    it(`${subKind}: does not contain the fake license key fixture`, () => {
      const guidance = buildGuidance(subKind);
      expect(guidance).not.toContain(FAKE_LICENSE_KEY);
    });
  }

  // New tests for renewalUrl parameter
  it('buildGuidance("expired", url) delegates to buildExpiredRenewalMessage', () => {
    const testUrl = "https://example.com/renew";
    const guidance = buildGuidance("expired", testUrl);
    const renewal = buildExpiredRenewalMessage(testUrl);
    expect(guidance).toBe(renewal);
  });

  it('buildGuidance("expired") without URL returns legacy copy', () => {
    const guidance = buildGuidance("expired");
    expect(guidance).toContain(LICENSE_SUPPORT_CONTACT);
    expect(guidance).not.toContain("Nutrient PDF Editor needs updating");
  });

  it('buildGuidance("invalid", anyUrl) ignores URL and returns same as without URL', () => {
    const testUrl = "https://example.com/renew";
    const withUrl = buildGuidance("invalid", testUrl);
    const withoutUrl = buildGuidance("invalid");
    expect(withUrl).toBe(withoutUrl);
  });

  it('buildGuidance("host-mismatch", anyUrl) ignores URL and returns same as without URL', () => {
    const testUrl = "https://example.com/renew";
    const withUrl = buildGuidance("host-mismatch", testUrl);
    const withoutUrl = buildGuidance("host-mismatch");
    expect(withUrl).toBe(withoutUrl);
  });

  it('buildGuidance("expired", "") falls through to legacy copy', () => {
    const guidance = buildGuidance("expired", "");
    const legacy = buildGuidance("expired");
    expect(guidance).toBe(legacy);
  });
});

// ---------------------------------------------------------------------------
// Session license state
// ---------------------------------------------------------------------------
describe("session license state", () => {
  beforeEach(() => {
    __resetForTesting();
  });

  it("getLicenseError returns null initially", () => {
    expect(getLicenseError()).toBeNull();
  });

  it("setLicenseError persists the payload", () => {
    const payload = {
      code: LICENSE_ERROR_CODE,
      subKind: "expired" as LicenseErrorSubKind,
      guidance: buildGuidance("expired"),
    };
    setLicenseError(payload);
    expect(getLicenseError()).toEqual(payload);
  });

  it("clearLicenseError removes the payload", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "invalid" as LicenseErrorSubKind,
      guidance: buildGuidance("invalid"),
    });
    clearLicenseError();
    expect(getLicenseError()).toBeNull();
  });

  it("setOpenDocument clears the license error (fix takes effect on next open)", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "expired" as LicenseErrorSubKind,
      guidance: buildGuidance("expired"),
    });
    setOpenDocument("/tmp/new.pdf");
    expect(getLicenseError()).toBeNull();
  });

  it("clearOpenDocument clears the license error", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "invalid" as LicenseErrorSubKind,
      guidance: buildGuidance("invalid"),
    });
    clearOpenDocument();
    expect(getLicenseError()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requireValidLicense
// ---------------------------------------------------------------------------
describe("requireValidLicense", () => {
  beforeEach(() => {
    __resetForTesting();
  });

  it("does not throw when no license error is set", () => {
    expect(() => requireValidLicense()).not.toThrow();
  });

  it("throws McpError(InvalidParams) when a license error is set", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "expired" as LicenseErrorSubKind,
      guidance: buildGuidance("expired"),
    });
    expect(() => requireValidLicense()).toThrow(McpError);
  });

  it("thrown McpError has ErrorCode.InvalidParams", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "invalid" as LicenseErrorSubKind,
      guidance: buildGuidance("invalid"),
    });
    try {
      requireValidLicense();
    } catch (err) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });

  it("thrown McpError carries license code in data field, not message prefix", () => {
    const guidance = buildGuidance("host-mismatch");
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "host-mismatch" as LicenseErrorSubKind,
      guidance,
    });
    try {
      requireValidLicense();
    } catch (err) {
      const error = err as McpError;
      // Message contains the guidance text (not the MESSAGE = guidance exactly; McpError adds its own prefix)
      expect(error.message).toContain(guidance);
      // No LICENSE_ERROR_CODE: prefix anymore (the breaking change)
      expect(error.message).not.toContain("LICENSE_ERROR:");
      // Code is in the structured data, not the message
      expect(error.data).toBeDefined();
      expect((error.data as any).code).toBe(LICENSE_ERROR_CODE);
    }
  });

  it("thrown McpError.data contains code, subKind, and guidance", () => {
    const payload = {
      code: LICENSE_ERROR_CODE,
      subKind: "invalid" as LicenseErrorSubKind,
      guidance: buildGuidance("invalid"),
    };
    setLicenseError(payload);
    try {
      requireValidLicense();
    } catch (err) {
      const data = (err as McpError).data as typeof payload;
      expect(data).toBeDefined();
      expect(data.code).toBe(LICENSE_ERROR_CODE);
      expect(data.subKind).toBe("invalid");
      expect(typeof data.guidance).toBe("string");
      expect(data.guidance).toContain(LICENSE_SUPPORT_CONTACT);
    }
  });

  it("error data does NOT contain the fake license key value", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "invalid" as LicenseErrorSubKind,
      // Guidance is built from subKind alone — no key value ever included.
      guidance: buildGuidance("invalid"),
    });
    try {
      requireValidLicense();
    } catch (err) {
      const message = (err as McpError).message;
      const data = JSON.stringify((err as McpError).data ?? {});
      expect(message).not.toContain(FAKE_LICENSE_KEY);
      expect(data).not.toContain(FAKE_LICENSE_KEY);
    }
  });

  it("does NOT throw after license error is cleared (fix takes effect)", () => {
    setLicenseError({
      code: LICENSE_ERROR_CODE,
      subKind: "expired" as LicenseErrorSubKind,
      guidance: buildGuidance("expired"),
    });
    clearLicenseError();
    expect(() => requireValidLicense()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// submit_response sentinel: LICENSE_ERROR_REQUEST_ID handling
// ---------------------------------------------------------------------------
describe("submit_response license-error sentinel", () => {
  beforeEach(() => {
    __resetForTesting();
  });

  it("LICENSE_ERROR_REQUEST_ID is the sentinel value", () => {
    expect(typeof LICENSE_ERROR_REQUEST_ID).toBe("string");
    expect(LICENSE_ERROR_REQUEST_ID).toBe("__license_error__");
  });

  it("setLicenseError + getLicenseError round-trip preserves sub-kind", () => {
    const subKinds: LicenseErrorSubKind[] = [
      "invalid", "expired", "host-mismatch"
    ];
    for (const subKind of subKinds) {
      __resetForTesting();
      setLicenseError({
        code: LICENSE_ERROR_CODE,
        subKind,
        guidance: buildGuidance(subKind),
      });
      const stored = getLicenseError();
      expect(stored?.subKind).toBe(subKind);
      expect(stored?.code).toBe(LICENSE_ERROR_CODE);
    }
  });
});

