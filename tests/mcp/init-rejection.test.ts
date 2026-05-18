/**
 * Init-time UI capability gate (`src/mcp/require-ui-capability.ts`).
 *
 * Every public tool depends on the embedded Nutrient Web SDK
 * iframe being mounted by the host as an MCP App resource. Without UI
 * rendering there is no viewer, no `viewUUID`, and every tool call fails
 * with a generic `VIEWER_TIMEOUT_MS` timeout. We gate `initialize` on the
 * MCP Apps `io.modelcontextprotocol/ui` extension so the host receives a
 * single actionable JSON-RPC error instead of N round-trip timeouts.
 *
 * Each test spawns a fresh server process so the rejection-path test
 * doesn't leave the server stuck in a half-initialized state for the
 * accept-path test.
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCPClient } from "../integration/mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

const EXTENSION_ID = "io.modelcontextprotocol/ui";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
// JSON-RPC error code -32600 is `InvalidRequest` per the MCP / JSON-RPC 2.0 spec.
const INVALID_REQUEST_CODE = -32600;

describe("require-ui-capability (init rejection)", () => {
  let client: MCPClient | null = null;

  beforeAll(() => {
    const distPath = path.join(projectRoot, "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
  });

  afterEach(() => {
    client?.close();
    client = null;
  });

  it("accepts initialize when capabilities.extensions advertises the UI capability with the required mime type", async () => {
    client = new MCPClient(fixturesDir);
    const res = await client.send({
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          extensions: {
            [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] }
          }
        },
        clientInfo: { name: "test", version: "1.0" }
      }
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    // Same `InitializeResult` shape the SDK default returns: protocolVersion,
    // capabilities, serverInfo, and (because we declare instructions on
    // createServer) instructions.
    expect(res.result!.protocolVersion).toBeDefined();
    expect(res.result!.capabilities).toBeDefined();
    expect(res.result!.capabilities.tools).toBeDefined();
    expect(res.result!.serverInfo).toEqual({
      name: "Nutrient PDF Editor",
      version: "0.1.0"
    });
    expect(typeof res.result!.instructions).toBe("string");
    expect(res.result!.instructions).toMatch(/open_document/);
  });

  it("rejects initialize with InvalidRequest when capabilities.extensions is absent", async () => {
    client = new MCPClient(fixturesDir);
    const res = await client.send({
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" }
      }
    });

    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(INVALID_REQUEST_CODE);
    expect(res.error.message).toContain(EXTENSION_ID);
    expect(res.error.message).toContain(RESOURCE_MIME_TYPE);
  });

  it("rejects initialize when extensions[ui] is present but mimeTypes does not include the required type", async () => {
    client = new MCPClient(fixturesDir);
    const res = await client.send({
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          extensions: {
            [EXTENSION_ID]: { mimeTypes: ["application/json"] }
          }
        },
        clientInfo: { name: "test", version: "1.0" }
      }
    });

    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(INVALID_REQUEST_CODE);
    expect(res.error.message).toContain(EXTENSION_ID);
    expect(res.error.message).toContain(RESOURCE_MIME_TYPE);
  });

  it("accepts initialize when the capability is advertised under capabilities.experimental (lenient fallback)", async () => {
    // We accept either `extensions` or `experimental` to avoid locking out a
    // host that has not yet migrated to the spec-2026-01-26 shape.
    client = new MCPClient(fixturesDir);
    const res = await client.send({
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          experimental: {
            [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] }
          }
        },
        clientInfo: { name: "test", version: "1.0" }
      }
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    expect(res.result!.capabilities.tools).toBeDefined();
    expect(res.result!.serverInfo.name).toBe("Nutrient PDF Editor");
  });
});
