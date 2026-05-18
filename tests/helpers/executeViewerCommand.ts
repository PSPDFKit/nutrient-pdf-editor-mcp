/**
 * H2: executeViewerCommand — collapses the standard viewer-command ceremony into
 * a single call.
 *
 * Pattern it replaces (~5 lines per test case):
 *   const resultPromise = client.callTool(name, args);
 *   await flushMicrotasks();
 *   const [cmd] = sessionModule.drain();
 *   sessionModule.resolvePending(cmd.requestId, payload);
 *   const result = await resultPromise;
 *
 * Throws if drain() returns more than one command, so tests that exercise
 * multi-command flows must continue to use the raw API.
 */

import * as sessionModule from "../../src/mcp/session.js";
import { flushMicrotasks, type TestClient } from "./mcpTestClient.js";

/**
 * Execute a single viewer command round-trip and return the tool result.
 *
 * @param client - The TestClient returned by createTestClient or createSessionFixture.
 * @param toolName - MCP tool name (e.g. "read_text").
 * @param args - Tool arguments.
 * @param payload - Viewer response payload passed to resolvePending.
 * @returns The awaited CallToolResult.
 * @throws If drain() returns 0 or more than 1 command (multi-command flows must
 *   use the raw API).
 */
export async function executeViewerCommand(
  client: Pick<TestClient, "callTool">,
  toolName: string,
  args: Record<string, unknown>,
  payload: unknown
): Promise<{
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [k: string]: unknown;
}> {
  const resultPromise = client.callTool(toolName, args);

  await flushMicrotasks();

  const commands = sessionModule.drain();
  if (commands.length !== 1) {
    throw new Error(
      `executeViewerCommand: expected exactly 1 command but drain() returned ${commands.length}. ` +
        `Use the raw API for multi-command flows.`
    );
  }

  const cmd = commands[0]!;
  sessionModule.resolvePending((cmd as unknown as { requestId: string }).requestId, payload);

  return resultPromise;
}
