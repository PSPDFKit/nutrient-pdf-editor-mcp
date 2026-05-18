import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatDocumentInfo } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";

interface DocInfoPayload {
  pageCount: number;
  title?: string;
  permissions: Record<string, boolean>;
}

export function registerDocumentInformationTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<Record<string, never>, DocInfoPayload>(server, allToolsRegistry, {
    name: "read_document_information",
    title: "Read document information",
    annotations: { readOnlyHint: true },
    description:
      "Use when needing structural facts about the open document before deciding how to process it — total page count, title, and permissions (whether annotation, extraction, modification, printing are allowed). Useful as a sizing step before read_text or before suggesting page-by-page workflows.",
    inputSchema: {},
    command: (_input, requestId) => ({ type: "read_document_information", requestId }),
    formatResult: (_input, payload, _viewUUID) => {
      const structuredContent: Record<string, unknown> = {
        pageCount: payload.pageCount,
        permissions: payload.permissions
      };
      if (payload.title !== undefined) {
        structuredContent["title"] = payload.title;
      }
      const markdown = formatDocumentInfo({
        ...(payload.title !== undefined && { title: payload.title }),
        pageCount: payload.pageCount,
        permissions: payload.permissions
      });
      return {
        content: [{ type: "text", text: markdown }],
        structuredContent
      };
    }
  });
}
