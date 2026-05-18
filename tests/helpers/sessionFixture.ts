/**
 * H1: createSessionFixture — encapsulates the standard MCP-test session/client-roots
 * lifecycle used across tests/mcp/*.test.ts.
 *
 * Creates a temp dir, registers it as a client root, resets session state,
 * registers caller-supplied tools, and wires a connected MCP test client.
 * Call cleanup() in afterEach to tear down resources.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import * as sessionModule from "../../src/mcp/session.js";
import { setClientRoots, clearClientRoots } from "../../src/mcp/client-roots.js";
import { createTestClient, type TestClient } from "./mcpTestClient.js";

export interface SessionFixture extends TestClient {
  /** Absolute path to the temp directory registered as the client root. */
  tempDir: string;
  /** The underlying McpServer — exposed for spying (e.g. elicitInput). */
  server: McpServer;
  /** Tear down: clear session + client roots + remove tempDir. Call in afterEach. */
  cleanup(): void;
}

/**
 * Create a standard MCP test session fixture.
 *
 * @param register - Tool registration callback(s) to run against the server.
 * @param opts.openFixturePdf - If true (default), registers a fixture PDF path
 *   as the open document so document-guard checks pass.
 * @param opts.prefix - Prefix for the temp directory name.
 * @param opts.extraCapabilities - Forwarded to createTestClient (e.g. `{ elicitation: {} }`).
 */
export async function createSessionFixture(
  register: ((server: McpServer) => void) | Array<(server: McpServer) => void>,
  opts: {
    openFixturePdf?: boolean;
    prefix?: string;
    extraCapabilities?: Partial<ServerCapabilities> & { elicitation?: Record<string, never> };
  } = {}
): Promise<SessionFixture> {
  const { openFixturePdf = true, prefix = "nutrient-pdf-editor-", extraCapabilities } = opts;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  setClientRoots([{ uri: pathToFileURL(tempDir).href }]);

  const state = sessionModule.getSession();
  state.viewUUID = randomUUID();
  state.pending = new Map();

  if (openFixturePdf) {
    sessionModule.setOpenDocument(path.join(tempDir, "fixture.pdf"));
  }

  const registerFns = Array.isArray(register) ? register : [register];
  const client = await createTestClient(registerFns, extraCapabilities);

  function cleanup(): void {
    sessionModule.clearOpenDocument();
    clearClientRoots();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }

  return {
    tempDir,
    server: client.server,
    callTool: client.callTool,
    cleanup,
  };
}
