import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  requireOpenDocument,
  requireFreshDocument,
  requireValidLicense,
  NO_DOCUMENT_OPEN_MESSAGE,
  DOCUMENT_STALE_MESSAGE
} from "../../src/mcp/document-guard.js";
import {
  setOpenDocument,
  clearOpenDocument,
  hasOpenDocument,
  setDocumentDirty,
  isDocumentDirty,
  setLicenseError,
  __resetForTesting
} from "../../src/mcp/session.js";
import { buildGuidance } from "../../src/contract/viewer-errors.js";
import { DEFAULT_RENEWAL_URL } from "../../src/mcp/app-resource.js";

describe("requireOpenDocument", () => {
  beforeEach(() => {
    clearOpenDocument();
  });

  afterEach(() => {
    clearOpenDocument();
  });

  it("returns void when a document is open", () => {
    setOpenDocument("/tmp/example.pdf");
    expect(hasOpenDocument()).toBe(true);
    expect(() => requireOpenDocument()).not.toThrow();
  });

  it("throws McpError(InvalidParams) when no document is open", () => {
    expect(hasOpenDocument()).toBe(false);
    expect(() => requireOpenDocument()).toThrow(McpError);
    try {
      requireOpenDocument();
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain(NO_DOCUMENT_OPEN_MESSAGE);
    }
  });

  it("throws again after a document is closed", () => {
    setOpenDocument("/tmp/example.pdf");
    expect(() => requireOpenDocument()).not.toThrow();
    clearOpenDocument();
    expect(() => requireOpenDocument()).toThrow(/no document is currently open/i);
  });

});

describe("requireFreshDocument", () => {
  beforeEach(() => {
    clearOpenDocument(); // also resets the dirty flag
  });

  afterEach(() => {
    clearOpenDocument();
  });

  it("returns void when the dirty flag is unset", () => {
    expect(isDocumentDirty()).toBe(false);
    expect(() => requireFreshDocument()).not.toThrow();
  });

  it("throws McpError(InvalidParams) when the dirty flag is set", () => {
    setDocumentDirty(true);
    expect(() => requireFreshDocument()).toThrow(McpError);
    try {
      requireFreshDocument();
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain(DOCUMENT_STALE_MESSAGE);
    }
  });

  it("clearOpenDocument resets the dirty flag, restoring freshness", () => {
    setOpenDocument("/tmp/foo.pdf");
    setDocumentDirty(true);
    expect(() => requireFreshDocument()).toThrow();
    clearOpenDocument();
    expect(() => requireFreshDocument()).not.toThrow();
  });

  it("is independent of requireOpenDocument: dirty + open still throws stale", () => {
    setOpenDocument("/tmp/foo.pdf");
    setDocumentDirty(true);
    expect(() => requireOpenDocument()).not.toThrow();
    expect(() => requireFreshDocument()).toThrow(/has changed since it was opened/i);
  });
});

// Fixture license key for AC2.4 safety testing
const FIXTURE_LICENSE_KEY = "FAKE-EXPIRED-TOKEN-MUST-NOT-APPEAR-IN-OUTPUT-DEADBEEF";

describe("requireValidLicense", () => {
  const originalEnv = process.env.NUTRIENT_RENEWAL_URL;

  beforeEach(() => {
    __resetForTesting();
  });

  afterEach(() => {
    __resetForTesting();
    // Restore env to original state
    if (originalEnv !== undefined) {
      process.env.NUTRIENT_RENEWAL_URL = originalEnv;
    } else {
      delete process.env.NUTRIENT_RENEWAL_URL;
    }
    // Clean up license key env var
    delete process.env.NUTRIENT_LICENSE_KEY;
  });

  it("AC2.3 — expired McpError message uses configured URL", () => {
    process.env.NUTRIENT_RENEWAL_URL = "https://example.com/renew";

    setLicenseError({
      code: "LICENSE_ERROR",
      subKind: "expired",
      guidance: "any leftover string"
    });

    try {
      requireValidLicense();
      expect.fail("should have thrown McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const error = err as McpError;
      expect(error.code).toBe(ErrorCode.InvalidParams);

      const expectedMessage = buildGuidance("expired", "https://example.com/renew");
      expect(error.message).toContain(expectedMessage);
      expect(error.message).toContain("https://example.com/renew");
      expect(error.message).not.toContain("https://www.nutrient.io/support/");
    }
  });

  it("AC2.3 — expired McpError uses default URL when env unset", () => {
    delete process.env.NUTRIENT_RENEWAL_URL;

    setLicenseError({
      code: "LICENSE_ERROR",
      subKind: "expired",
      guidance: "any leftover string"
    });

    try {
      requireValidLicense();
      expect.fail("should have thrown McpError");
    } catch (err) {
      const error = err as McpError;
      const expectedMessage = buildGuidance("expired", DEFAULT_RENEWAL_URL);
      expect(error.message).toContain(expectedMessage);
    }
  });

  it("AC2.3 — invalid sub-kind keeps legacy copy", () => {
    process.env.NUTRIENT_RENEWAL_URL = "https://example.com/renew";

    setLicenseError({
      code: "LICENSE_ERROR",
      subKind: "invalid",
      guidance: "any leftover string"
    });

    try {
      requireValidLicense();
      expect.fail("should have thrown McpError");
    } catch (err) {
      const error = err as McpError;
      const expectedMessage = buildGuidance("invalid");
      expect(error.message).toContain(expectedMessage);
      expect(error.message).not.toContain("https://example.com/renew");
    }
  });

  it("AC2.3 — host-mismatch sub-kind keeps legacy copy", () => {
    process.env.NUTRIENT_RENEWAL_URL = "https://example.com/renew";

    setLicenseError({
      code: "LICENSE_ERROR",
      subKind: "host-mismatch",
      guidance: "any leftover string"
    });

    try {
      requireValidLicense();
      expect.fail("should have thrown McpError");
    } catch (err) {
      const error = err as McpError;
      const expectedMessage = buildGuidance("host-mismatch");
      expect(error.message).toContain(expectedMessage);
      expect(error.message).not.toContain("https://example.com/renew");
    }
  });

  it("AC2.4 — license-key never leaks in McpError message or data", () => {
    process.env.NUTRIENT_LICENSE_KEY = FIXTURE_LICENSE_KEY;
    process.env.NUTRIENT_RENEWAL_URL = "https://example.com/renew";

    setLicenseError({
      code: "LICENSE_ERROR",
      subKind: "expired",
      guidance: "any leftover string"
    });

    try {
      requireValidLicense();
      expect.fail("should have thrown McpError");
    } catch (err) {
      const error = err as McpError;
      // Check message does not contain the fixture key
      expect(error.message.includes(FIXTURE_LICENSE_KEY)).toBe(false);
      // Check stringified error fields do not contain the fixture key
      const stringified = JSON.stringify({
        message: error.message,
        code: error.code,
        data: error.data
      });
      expect(stringified.includes(FIXTURE_LICENSE_KEY)).toBe(false);
    }
  });

  it("no-license state is no-op", () => {
    __resetForTesting();
    expect(() => requireValidLicense()).not.toThrow();
  });
});
