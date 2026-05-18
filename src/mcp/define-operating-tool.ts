/**
 * `defineOperatingTool` factory.
 *
 * Owns the guard chain + bridge round-trip + viewUUID re-emission +
 * dual content/structuredContent/_meta return shape that every
 * operating tool repeats. Each tool file collapses to ~10–20 LOC.
 *
 * Returns `void` and writes to both `server` and `allToolsRegistry`
 * directly — the SDK-internal `RegisteredTool` type never leaks into
 * individual tool file signatures.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { getSession } from "./session.js";
import { enqueueAndWait } from "./bridge.js";
import {
  requireValidLicense,
  requireOpenDocument,
  requireFreshDocument
} from "./document-guard.js";
import type { ViewerCommand } from "./session.js";

// Zod raw shape type that matches what server.registerTool accepts.
// Copied from the SDK's internal interface so callers don't need to import it.
type ZodRawShape = { [k: string]: z.ZodTypeAny };

/**
 * Return type of the `formatResult` callback. `structuredContent` must be a
 * plain object (Record<string, unknown>) that can be serialised to JSON by the
 * SDK. `content` is one or more MCP content blocks (text, image, etc.).
 */
export interface OperatingToolResult {
  content: ContentBlock[];
  structuredContent: Record<string, unknown>;
}

/**
 * MCP tool annotation hints declared at registration time. Marketplace
 * submission criteria (https://claude.com/docs/connectors/building/submission)
 * require every tool to declare a `title` and the applicable hint.
 *
 * Both hint fields are optional so non-readonly / non-destructive tools
 * (e.g. `create_annotation`) can pass `annotations: {}` — absence is the
 * spec-correct way to express "not asserted". The `annotations` object
 * itself is required on `OperatingToolDef` so a tool author has to make
 * the choice consciously rather than copy-pasting from a reviewer-only
 * sibling and shipping a wrong hint.
 */
export interface OperatingToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * Definition object passed to `defineOperatingTool`.
 *
 * @template I  Inferred input type from `inputSchema` (Zod `z.infer<...>`)
 * @template P  Payload type returned by the viewer for this command
 */
export interface OperatingToolDef<I, P> {
  /** Tool name as registered with the MCP server (e.g. `"search_exact_text"`). */
  name: string;
  /**
   * Short human-readable label surfaced in `tools/list#tools[].title`.
   * Required by Anthropic's marketplace submission criteria.
   */
  title: string;
  /** Human-readable description shown in tools/list. */
  description: string;
  /**
   * MCP tool annotation hints. Required (the object itself; the hint
   * fields inside stay optional — see `OperatingToolAnnotations`).
   */
  annotations: OperatingToolAnnotations;
  /** Zod raw shape for validating tool input. Pass `{}` for no-input tools. */
  inputSchema: ZodRawShape;
  /**
   * Build the ViewerCommand to enqueue. Receives the validated input and a
   * freshly-generated `requestId`; must include both in the returned command.
   */
  command: (input: I, requestId: string) => ViewerCommand;
  /**
   * Translate the typed viewer payload into an MCP result. Receives the
   * validated tool input, the viewer payload, and the current `viewUUID` (so
   * callers don't need a separate `getSession()` call). `viewUUID` is also
   * auto-merged into `structuredContent` by the factory — no need to include
   * it in the returned `structuredContent`.
   */
  formatResult: (input: I, payload: P, viewUUID: string) => OperatingToolResult;
}

/**
 * Register one operating tool on `server` and add it to `allToolsRegistry`.
 *
 * The factory owns:
 * 1. `requireValidLicense()` + `requireOpenDocument()` + `requireFreshDocument()`
 * 2. `randomUUID()` for the per-request correlation ID
 * 3. `enqueueAndWait<P>(command, requestId)` — the bridge round-trip
 * 4. `getSession().viewUUID` re-emission on the result
 * 5. `{ content, structuredContent, _meta: { viewUUID } }` return shape
 *
 * Returns `void` — the SDK-internal `RegisteredTool` type stays internal.
 *
 * `allToolsRegistry` is optional: when omitted (e.g. in unit tests that call
 * the registration function directly without a server-level registry), the tool
 * is still registered on `server` and is callable via `tools/call`. Only the
 * `tools/list` filter in `installInternalToolsFilter` needs the registry.
 */
export function defineOperatingTool<I, P>(
  server: McpServer,
  allToolsRegistry: Map<string, RegisteredTool> | undefined,
  def: OperatingToolDef<I, P>
): void {
  const tool = server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations
    },
    async (input: unknown) => {
      requireValidLicense();
      requireOpenDocument();
      requireFreshDocument();
      const requestId = randomUUID();

      const typedInput = input as I;
      const command = def.command(typedInput, requestId);
      const payload = await enqueueAndWait<P>(command, requestId);
      const { viewUUID } = getSession();
      const { content, structuredContent } = def.formatResult(typedInput, payload, viewUUID);

      return {
        content,
        structuredContent: { ...structuredContent, viewUUID },
        _meta: { viewUUID }
      };
    }
  );
  allToolsRegistry?.set(def.name, tool);
}
