import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  normalizeObjectSchema,
  type AnySchema,
  type ZodRawShapeCompat
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

// JSON Schema for empty object, matching SDK's default
const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object" as const,
  properties: {}
};

/**
 * Pre-computed Tool definition derived from a RegisteredTool at registration
 * time. 2B.L1: computing the JSON Schema conversion on every tools/list
 * request is wasteful — the inputSchema never changes after registration.
 * We compute it once here and serve from cache on each tools/list call.
 */
interface CachedToolEntry {
  registeredTool: RegisteredTool;
  toolDefinition: Tool;
}

function computeToolDefinition(name: string, registeredTool: RegisteredTool): Tool {
  const inputSchema = (() => {
    const obj = normalizeObjectSchema(
      registeredTool.inputSchema as AnySchema | ZodRawShapeCompat | undefined
    );
    return obj
      ? toJsonSchemaCompat(obj, {
          strictUnions: true,
          pipeStrategy: "input"
        })
      : EMPTY_OBJECT_JSON_SCHEMA;
  })();

  const toolDefinition: Record<string, unknown> = {
    name,
    title: registeredTool.title,
    description: registeredTool.description,
    inputSchema,
    annotations: registeredTool.annotations,
    execution: registeredTool.execution,
    _meta: registeredTool._meta
  };

  // Optionally include outputSchema if present
  if (registeredTool.outputSchema) {
    const obj = normalizeObjectSchema(
      registeredTool.outputSchema as AnySchema | ZodRawShapeCompat | undefined
    );
    if (obj) {
      toolDefinition.outputSchema = toJsonSchemaCompat(obj, {
        strictUnions: true,
        pipeStrategy: "output"
      });
    }
  }

  return toolDefinition as Tool;
}

/**
 * Install a custom tools/list filter that hides internal tools from the model
 * while keeping them callable via tools/call from the iframe. Required because
 * the SDK's tools/call handler checks tool.enabled before invoking, so we
 * cannot simply disable internal tools.
 *
 * Uses the same JSON Schema transformation as the SDK's built-in tools/list
 * handler to ensure compatibility with MCP clients.
 *
 * 2B.L1: inputSchema JSON Schema is computed once at registration time and
 * served from cache on every tools/list call. The schema is derived entirely
 * from the zod shape defined at tool registration — it never changes at runtime.
 *
 * @param server - The MCP server instance
 * @param allToolsRegistry - Map of tool name to RegisteredTool for all tools (public + internal)
 * @param internalToolsToHide - Array of RegisteredTool references for tools to hide from tools/list
 */
export function installInternalToolsFilter(
  server: McpServer,
  allToolsRegistry: Map<string, RegisteredTool>,
  internalToolsToHide: RegisteredTool[]
): void {
  // 2B.L1: build the per-tool cache at registration time. Internal tools are
  // still cached (their definition is computed) but excluded from the response.
  const internalSet = new Set<RegisteredTool>(internalToolsToHide);
  const toolCache: CachedToolEntry[] = [];

  for (const [name, registeredTool] of allToolsRegistry.entries()) {
    if (internalSet.has(registeredTool)) continue;
    toolCache.push({
      registeredTool,
      toolDefinition: computeToolDefinition(name, registeredTool)
    });
  }

  const underlying = server.server;
  underlying.setRequestHandler(ListToolsRequestSchema, async () => {
    // Serve the pre-computed tool list directly — no JSON Schema work per call.
    const tools = toolCache.map((entry) => entry.toolDefinition);
    return { tools };
  });
}
