/**
 * 3A.L-4: Unit tests for require-ui-capability.ts.
 *
 * These cover the gate logic directly — without spawning a server process —
 * so a regression in the gate surfacces as a unit failure before the
 * integration tests (init-rejection.test.ts) catch it end-to-end.
 */
import { describe, it, expect } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  readUiCapability,
  requireUiCapability,
} from "../../src/mcp/require-ui-capability.js";
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

const VALID_CAPS = {
  extensions: {
    [EXTENSION_ID]: {
      mimeTypes: [RESOURCE_MIME_TYPE],
    },
  },
};

describe("readUiCapability", () => {
  it("returns undefined for null capabilities", () => {
    expect(readUiCapability(null)).toBeUndefined();
  });

  it("returns undefined for undefined capabilities", () => {
    expect(readUiCapability(undefined)).toBeUndefined();
  });

  it("returns undefined when neither extensions nor experimental has the key", () => {
    expect(readUiCapability({})).toBeUndefined();
  });

  it("returns the capability from extensions[EXTENSION_ID]", () => {
    const cap = readUiCapability(VALID_CAPS);
    expect(cap).toBeDefined();
    expect(cap!.mimeTypes).toContain(RESOURCE_MIME_TYPE);
  });

  it("falls back to experimental[EXTENSION_ID] when extensions is absent", () => {
    const caps = {
      experimental: {
        [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
      },
    };
    const cap = readUiCapability(caps);
    expect(cap).toBeDefined();
    expect(cap!.mimeTypes).toContain(RESOURCE_MIME_TYPE);
  });

  it("prefers extensions over experimental when both present", () => {
    const caps = {
      extensions: {
        [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
      },
      experimental: {
        [EXTENSION_ID]: { mimeTypes: ["other/type"] },
      },
    };
    const cap = readUiCapability(caps);
    expect(cap!.mimeTypes).toContain(RESOURCE_MIME_TYPE);
  });
});

describe("requireUiCapability", () => {
  it("returns void (does not throw) when the correct capability is advertised", () => {
    expect(() => requireUiCapability(VALID_CAPS)).not.toThrow();
  });

  it("throws McpError(InvalidRequest) when capabilities is null", () => {
    expect(() => requireUiCapability(null)).toThrow(McpError);
    try {
      requireUiCapability(null);
    } catch (err) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((err as McpError).message).toContain(EXTENSION_ID);
      expect((err as McpError).message).toContain(RESOURCE_MIME_TYPE);
    }
  });

  it("throws McpError(InvalidRequest) when capabilities is empty {}", () => {
    expect(() => requireUiCapability({})).toThrow(McpError);
  });

  it("throws McpError(InvalidRequest) when mimeTypes array is missing", () => {
    const caps = {
      extensions: {
        [EXTENSION_ID]: {},
      },
    };
    expect(() => requireUiCapability(caps)).toThrow(McpError);
  });

  it("throws McpError(InvalidRequest) when mimeTypes does not include the required type", () => {
    const caps = {
      extensions: {
        [EXTENSION_ID]: { mimeTypes: ["text/plain"] },
      },
    };
    expect(() => requireUiCapability(caps)).toThrow(McpError);
  });

  it("accepts capability from experimental slot (lenient fallback)", () => {
    const caps = {
      experimental: {
        [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
      },
    };
    expect(() => requireUiCapability(caps)).not.toThrow();
  });

  it("throws with a message referencing the extension ID so hosts know what to fix", () => {
    try {
      requireUiCapability({});
    } catch (err) {
      expect((err as McpError).message).toContain("io.modelcontextprotocol/ui");
    }
  });
});
