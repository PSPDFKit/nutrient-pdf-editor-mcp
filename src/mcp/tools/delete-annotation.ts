import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineOperatingTool } from "../define-operating-tool.js";

interface DeleteAnnotationPayload {
  id: string;
  annotation?: unknown;
}

export function registerDeleteAnnotationTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<{ id: string }, DeleteAnnotationPayload>(server, allToolsRegistry, {
    name: "delete_annotation",
    title: "Delete annotation",
    annotations: {},
    description:
      "Use when removing prior markup — un-highlighting, removing a sticky note, dropping a draft redaction the user changed their mind about. Works for all annotation types including unapplied redactions. Once a redaction has been applied via apply_annotations the underlying content is gone and cannot be recovered by deleting anything.",
    inputSchema: {
      id: z.string().min(1).describe("The annotation id to delete")
    },
    command: (input, requestId) => ({
      type: "delete_annotation",
      requestId,
      id: input.id
    }),
    formatResult: (_input, payload, _viewUUID) => ({
      content: [{ type: "text", text: `Successfully deleted annotation ${payload.id}` }],
      structuredContent: {
        id: payload.id,
        annotation: payload.annotation ?? null
      }
    })
  });
}
