import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getSession } from "../session.js";
import { enqueueAndWait } from "../bridge.js";
import {
  requireValidLicense,
  requireOpenDocument,
  requireFreshDocument
} from "../document-guard.js";

// Serialized form of the Nutrient Web SDK's TextSelection (ITextSelection_2).
// The viewer returns this shape from get_view_state when the user has selected
// text, and accepts it in set_view_state to restore a prior selection.
// Matches @nutrient-sdk/viewer dist/index.d.ts ITextSelection_2.
const selectionSchema = z
  .object({
    startPageIndex: z.number().nullable(),
    endPageIndex: z.number().nullable(),
    startTextLineId: z.number().nullable(),
    endTextLineId: z.number().nullable(),
    startNestedContentBlockId: z.string().nullable(),
    endNestedContentBlockId: z.string().nullable()
  })
  .describe(
    "Serialized text selection — start/end page index and text-line IDs. " +
      "Obtain from a prior get_view_state response's `selection` field."
  );

interface ViewStateResult extends Record<string, unknown> {
  documentPath: string;
  pageCount: number;
  activePage: number;
  selection?: unknown;
  viewUUID: string;
}

export function registerViewStateTools(server: McpServer): RegisteredTool[] {
  // get_view_state: returns current view state
  const get = server.registerTool(
    "get_view_state",
    {
      title: "Get view state",
      description:
        "Use when checking which page the user is currently looking at, or when needing the page count or document path mid-workflow. Returns active page, page count, document path, and current selection (if any).",
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      requireValidLicense();
      requireOpenDocument();
      requireFreshDocument();
      const requestId = randomUUID();

      const typed = await enqueueAndWait<{
        documentPath: string;
        pageCount: number;
        activePage: number;
        selection?: unknown;
      }>({ type: "get_view_state", requestId }, requestId);

      const { viewUUID } = getSession();
      const result: ViewStateResult = {
        documentPath: typed.documentPath,
        pageCount: typed.pageCount,
        activePage: typed.activePage,
        ...(typed.selection !== undefined && { selection: typed.selection }),
        viewUUID
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        _meta: { viewUUID }
      };
    }
  );

  // set_view_state: update view state with bounds checking on viewer side
  const set = server.registerTool(
    "set_view_state",
    {
      title: "Set view state",
      description:
        "Use when guiding the user's attention in the viewer they are watching — jumping to a page so they see the same evidence you are quoting, scrolling to a specific clause or table, or selecting text to highlight what you found. At least one of activePage, scrollTo, or selection must be provided.",
      annotations: {},
      inputSchema: {
        activePage: z.number().optional().describe("Page index to navigate to"),
        scrollTo: z
          .object({
            pageIndex: z.number().describe("Page index to scroll to"),
            rect: z
              .object({
                left: z.number(),
                top: z.number(),
                width: z.number(),
                height: z.number()
              })
              .describe("Rectangle bounds on the page")
          })
          .optional()
          .describe("Scroll to a specific rect on a page"),
        // At least one of activePage, scrollTo, or selection must be provided.
        // The server handler enforces this at runtime; see the runtime guard below.
        selection: selectionSchema
          .optional()
          .describe(
            "Text selection to restore. At least one of activePage, scrollTo, or selection is required."
          )
      }
    },
    async ({ activePage, scrollTo, selection }) => {
      requireValidLicense();
      requireOpenDocument();
      requireFreshDocument();
      // Validate that at least one field is provided. The zod .refine() API
      // would ideally encode this in the tools/list JSON Schema, but the MCP
      // SDK's server.tool() accepts a ZodRawShape (flat key/value map), not a
      // ZodObject — so ZodEffects from .refine() is not accepted there. The
      // constraint is encoded in the tool description and in the selection field's
      // description above, and enforced here at runtime.
      if (activePage === undefined && scrollTo === undefined && selection === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "set_view_state requires at least one of activePage, scrollTo, selection"
        );
      }
      const requestId = randomUUID();

      const typed = await enqueueAndWait<ViewStateResult>(
        {
          type: "set_view_state",
          requestId,
          ...(activePage !== undefined && { activePage }),
          ...(scrollTo !== undefined && { scrollTo }),
          ...(selection !== undefined && { selection })
        },
        requestId
      );

      const { viewUUID } = getSession();
      const result: ViewStateResult = {
        documentPath: typed.documentPath,
        pageCount: typed.pageCount,
        activePage: typed.activePage,
        ...(typed.selection !== undefined && { selection: typed.selection }),
        viewUUID
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        _meta: { viewUUID }
      };
    }
  );

  return [get, set];
}
