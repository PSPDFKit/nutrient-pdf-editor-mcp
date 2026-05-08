import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Annotation, type AnnotationType } from "./annotation-types.js";
import { formatAnnotations } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";

interface ReadAnnotationsInput {
  pageIndex?: number;
  type?: string;
}

export function registerReadAnnotationsTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<ReadAnnotationsInput, { annotations: Annotation[] }>(
    server,
    allToolsRegistry,
    {
      name: "read_annotations",
      title: "Read annotations",
      annotations: { readOnlyHint: true },
      description:
        "Use when reviewing existing markup — listing what is already highlighted, redacted, commented, or otherwise annotated; auditing a reviewer's edits; collecting pending redactions before applying them. Returns a plain array of annotations with optional filtering by pageIndex or type.",
      inputSchema: {
        pageIndex: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("If provided, return annotations only from this page"),
        type: z
          .enum([
            "highlight",
            "note",
            "text",
            "ink",
            "strikeout",
            "underline",
            "squiggly",
            "link",
            "widget",
            "redaction"
          ])
          .optional()
          .describe("If provided, return only annotations of this type")
      },
      command: (input, requestId) => ({
        type: "read_annotations",
        requestId,
        ...(input.pageIndex !== undefined && { pageIndex: input.pageIndex }),
        ...(input.type !== undefined && { annotationType: input.type as AnnotationType })
      }),
      formatResult: (input, payload, _viewUUID) => ({
        content: [
          {
            type: "text",
            text: formatAnnotations(payload.annotations, input.pageIndex, input.type)
          }
        ],
        structuredContent: { annotations: payload.annotations }
      })
    }
  );
}
