import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AnnotationPatch } from "./annotation-types.js";
import { defineOperatingTool } from "../define-operating-tool.js";

type AnnotationPatchType = z.infer<typeof AnnotationPatch>;

interface UpdateAnnotationPayload {
  id: string;
  annotation?: unknown;
}

export function registerUpdateAnnotationTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<{ id: string; patch: AnnotationPatchType }, UpdateAnnotationPayload>(
    server,
    allToolsRegistry,
    {
      name: "update_annotation",
      title: "Update annotation",
      annotations: {},
      description:
        "Use when refining existing markup — adjusting a highlight's color, moving a redaction rect, editing a note's text, or resizing an ink stroke. Patches the named fields on the annotation; unmentioned fields are left as-is. Returns the id of the updated annotation.",
      inputSchema: {
        id: z.string().min(1).describe("The annotation id to update"),
        patch: AnnotationPatch.describe("Partial object with fields to update")
      },
      command: (input, requestId) => ({
        type: "update_annotation",
        requestId,
        id: input.id,
        patch: input.patch
      }),
      formatResult: (_input, payload, _viewUUID) => ({
        content: [{ type: "text", text: `Successfully updated annotation ${payload.id}` }],
        structuredContent: {
          id: payload.id,
          annotation: payload.annotation ?? null
        }
      })
    }
  );
}
