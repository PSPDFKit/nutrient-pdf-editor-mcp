/**
 * Test helper: creates a connected MCP Client + InMemoryTransport pair wrapping
 * an McpServer instance. Use this instead of `(server as any)._registeredTools`
 * so tool tests exercise the real MCP protocol path (serialization, schema
 * validation, error mapping) rather than calling handler functions directly.
 *
 * Usage:
 *
 *   const { callTool, server } = await createTestClient([registerMyTool]);
 *   const resultPromise = callTool("my_tool_name", { arg: "value" });
 *   await flushMicrotasks(); // let server process the request
 *   const commands = sessionModule.drain();
 *   sessionModule.resolvePending(commands[0].requestId, payload);
 *   const result = await resultPromise;
 *   expect(result.structuredContent).toEqual({ ... });
 *
 * Error cases: when a tool handler throws McpError, the MCP SDK converts it to
 * an isError:true result (NOT a thrown error). Check `result.isError === true`
 * and `(result.content[0] as any).text` for the error message.
 *
 * The `server` reference is exposed so tests can spy on internal methods (e.g.
 * `vi.spyOn(server.server, "elicitInput")` in apply-annotations tests).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Yield to the Node.js event loop so that all pending microtasks (including the
 * MCP SDK's internal Promise chains triggered by transport message delivery)
 * have settled. Use this after calling `callTool(...)` and before calling
 * `sessionModule.drain()`:
 *
 *   const resultPromise = callTool("tool_name", args);
 *   await flushMicrotasks();
 *   const commands = sessionModule.drain(); // now populated
 *
 * Prefer this over `await Promise.resolve()` (one microtask tick) because the
 * SDK dispatches tool handlers through a two-tick `.then(...).then(handler)`
 * chain inside `_onrequest`, so a single tick is not enough.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface TestClient {
  /** The McpServer instance — expose for spying on internal methods. */
  server: McpServer;
  /**
   * Call a tool by name and return the full CallToolResult.
   * Throws (as McpError) when the handler throws McpError.
   */
  callTool(
    name: string,
    args?: Record<string, unknown>
  ): Promise<{
    content: unknown[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
    [k: string]: unknown;
  }>;
}

/**
 * Create a connected MCP test client backed by a fresh McpServer.
 *
 * @param registerFns - Tool registration functions to call on the server before
 *   connecting. Pass them in the order you want tools registered.
 * @param extraCapabilities - Optional extra server capabilities (e.g.
 *   `{ elicitation: {} }` for apply-annotations tests).
 */
export async function createTestClient(
  registerFns: Array<(server: McpServer) => void>,
  extraCapabilities?: Partial<ServerCapabilities> & { elicitation?: Record<string, never> }
): Promise<TestClient> {
  const capabilities: ServerCapabilities & { elicitation?: Record<string, never> } = {
    tools: {},
    ...extraCapabilities
  };

  const server = new McpServer(
    { name: "test", version: "0.1.0" },
    { capabilities }
  );

  for (const register of registerFns) {
    register(server);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  // Connect server transport first (it responds to client initialize request)
  await server.connect(serverTransport);

  const client = new Client(
    { name: "test-client", version: "0.1.0" },
    { capabilities: {} }
  );
  // connect() triggers the MCP initialize handshake automatically
  await client.connect(clientTransport);

  return {
    server,
    callTool: (name, args = {}) =>
      client.callTool({ name, arguments: args }) as Promise<{
        content: unknown[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
        _meta?: Record<string, unknown>;
        [k: string]: unknown;
      }>
  };
}
