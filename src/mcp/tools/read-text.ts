import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineOperatingTool } from "../define-operating-tool.js";

interface ReadTextInput {
  pageStart?: number;
  pageEnd?: number;
}

interface ReadTextPayload {
  text: string;
  pageCount: number;
  firstPage: number;
  lastPage: number;
  extractedPages: number;
  truncated: boolean;
  nextPageStart: number | null;
}

export function registerReadTextTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<ReadTextInput, ReadTextPayload>(server, allToolsRegistry, {
    name: "read_text",
    title: "Read text",
    annotations: { readOnlyHint: true },
    description:
      "Use when extracting, summarizing, quoting, or reasoning over a document's full text — preferred over get_page_image for text-based tasks. Returns joined page text with page delimiters from the open document. Supports optional pageStart/pageEnd scoping; auto-paginates at 100,000 UTF-16 code units (characters) by trimming to the last full page that fits — pass the previous response's `nextPageStart` to continue a truncated read.",
    inputSchema: {
      pageStart: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Zero-based page index to start from. Defaults to 0. Pass the previous response's `nextPageStart` here to continue a truncated read."
        ),
      pageEnd: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Zero-based page index to end at (inclusive). Defaults to the last page.")
    },
    command: (input, requestId) => ({
      type: "read_text",
      requestId,
      pageStart: input.pageStart ?? 0,
      // -1 signals "use last page" to the viewer
      pageEnd: input.pageEnd ?? -1
    }),
    formatResult: (_input, payload, _viewUUID) => {
      // Plain text is delivered as-is in content[0].text. When the result is
      // truncated, append a one-line continuation hint so the model knows to
      // call again with `pageStart: nextPageStart`. Pagination metadata stays
      // in `structuredContent` for callers that need the numeric details.
      const lines: string[] = [payload.text];
      if (payload.truncated && payload.nextPageStart != null) {
        lines.push(
          "",
          `[Output truncated after page ${payload.lastPage} of ${payload.pageCount - 1}. Call read_text again with pageStart: ${payload.nextPageStart} to continue.]`
        );
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          text: payload.text,
          pageCount: payload.pageCount,
          firstPage: payload.firstPage,
          lastPage: payload.lastPage,
          extractedPages: payload.extractedPages,
          truncated: payload.truncated,
          nextPageStart: payload.nextPageStart
        }
      };
    }
  });
}
