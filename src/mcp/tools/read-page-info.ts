import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatPageInfo } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";

interface PageInfoPayload {
  width: number;
  height: number;
  rotation: number;
}

export function registerPageInfoTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<{ pageIndex: number }, PageInfoPayload>(server, allToolsRegistry, {
    name: "read_page_info",
    title: "Read page info",
    annotations: { readOnlyHint: true },
    description:
      "Use when needing a page's dimensions and rotation before placing an annotation — required to compute valid rectangle coordinates for highlights, redactions, ink, or stamps. Width and height are in PDF user-space units; rotation is degrees clockwise.",
    inputSchema: {
      pageIndex: z.number().describe("Zero-based page index")
    },
    command: (input, requestId) => ({
      type: "read_page_info",
      requestId,
      pageIndex: input.pageIndex
    }),
    formatResult: (input, payload, _viewUUID) => ({
      content: [
        {
          type: "text",
          text: formatPageInfo({
            pageIndex: input.pageIndex,
            width: payload.width,
            height: payload.height,
            rotation: payload.rotation
          })
        }
      ],
      structuredContent: {
        width: payload.width,
        height: payload.height,
        rotation: payload.rotation
      }
    })
  });
}
