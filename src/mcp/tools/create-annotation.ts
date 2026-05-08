import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AnnotationInput } from "./annotation-types.js";
import { defineOperatingTool } from "../define-operating-tool.js";

type AnnotationInputType = z.infer<typeof AnnotationInput>;

interface CreateAnnotationPayload {
  id: string;
  annotation?: unknown;
}

export function registerCreateAnnotationTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<{ annotation: AnnotationInputType }, CreateAnnotationPayload>(
    server,
    allToolsRegistry,
    {
      name: "create_annotation",
      title: "Create annotation",
      annotations: {},
      description:
        "Use when marking up the document — highlighting evidence, drawing a redaction box over PII, adding a sticky note, underlining a clause, drawing ink, or stamping. Creates one annotation of the supplied type and returns its id. To redact, create one or more redaction annotations and then call apply_annotations to burn them in.",
      inputSchema: {
        annotation: AnnotationInput.describe(
          "Annotation input with type, pageIndex, and type-specific fields"
        )
      },
      command: (input, requestId) => {
        let parsed: AnnotationInputType;
        try {
          parsed = AnnotationInput.parse(input.annotation);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new McpError(ErrorCode.InvalidParams, `Invalid annotation input: ${message}`);
        }
        return { type: "create_annotation", requestId, input: parsed };
      },
      formatResult: (input, payload, _viewUUID) => {
        const text = `Successfully created ${input.annotation.type} annotation with ID: ${payload.id}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            id: payload.id,
            annotation: payload.annotation ?? null
          }
        };
      }
    }
  );
}
