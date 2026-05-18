import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { formatPageImageMetadata } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";
// Shared constant so viewer and server agree on the default width.
import { DEFAULT_PAGE_IMAGE_WIDTH_PX } from "../../contract/constants.js";

interface PageImageInput {
  pageIndex: number;
  width?: number;
}

interface PageImagePayload {
  pngDataUrl: string;
  pageWidth?: number;
  pageHeight?: number;
  renderedWidth?: number;
}

const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

export function registerPageImageTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<PageImageInput, PageImagePayload>(server, allToolsRegistry, {
    name: "get_page_image",
    title: "Get page image",
    annotations: { readOnlyHint: true },
    description: `Use when the user needs to see what a page looks like — verifying a signature, examining a chart, figure, table, or layout, locating a stamp or handwritten mark, confirming redaction placement, or any task where the visual matters. Returns the rendered page as an MCP image content block plus a metadata text block. For text-only extraction, prefer read_text.`,
    inputSchema: {
      pageIndex: z.number().describe("Zero-based page index"),
      width: z
        .number()
        .optional()
        .describe(`Width in pixels (default ${DEFAULT_PAGE_IMAGE_WIDTH_PX})`)
    },
    command: (input, requestId) => ({
      type: "get_page_image",
      requestId,
      pageIndex: input.pageIndex,
      width: input.width ?? DEFAULT_PAGE_IMAGE_WIDTH_PX
    }),
    formatResult: (input, payload, _viewUUID) => {
      if (!payload.pngDataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
        throw new McpError(ErrorCode.InternalError, "viewer returned non-data-URL image");
      }
      const base64 = payload.pngDataUrl.slice(PNG_DATA_URL_PREFIX.length);
      const pageWidth = payload.pageWidth ?? 0;
      const pageHeight = payload.pageHeight ?? 0;
      const renderedWidth = payload.renderedWidth ?? 0;
      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" },
          {
            type: "text",
            text: formatPageImageMetadata(input.pageIndex, pageWidth, pageHeight, renderedWidth)
          }
        ],
        structuredContent: { pageWidth, pageHeight, renderedWidth }
      };
    }
  });
}
