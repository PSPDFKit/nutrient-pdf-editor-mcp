import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatTextSearchResults } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";

interface SearchHit {
  hitId: string;
  pageIndex: number;
  rect: { left: number; top: number; width: number; height: number };
  snippet: string;
}

interface SearchInput {
  query: string;
  pageIndex?: number;
}

export function registerSearchExactTextTool(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<SearchInput, { hits: SearchHit[] }>(server, allToolsRegistry, {
    name: "search_exact_text",
    title: "Search exact text",
    annotations: { readOnlyHint: true },
    description:
      "Use when locating a specific phrase, clause, name, or term in the open document — finding evidence, jumping to a section, verifying presence/absence of language. Exact-text only (no fuzzy or semantic match). Returns hits with page index, rect position, and snippet. For paraphrased or conceptual searches, use read_text and reason over the result instead.",
    inputSchema: {
      query: z.string().describe("Text to search for"),
      pageIndex: z.number().optional().describe("Optional: restrict search to a single page")
    },
    command: (input, requestId) => ({
      type: "search_exact_text",
      requestId,
      query: input.query,
      ...(input.pageIndex !== undefined && { pageIndex: input.pageIndex })
    }),
    formatResult: (input, payload, _viewUUID) => {
      const hits = payload.hits || [];
      const markdown = formatTextSearchResults({
        searchTerm: input.query,
        hits: hits.map((h) => ({
          pageIndex: h.pageIndex,
          previewText: h.snippet,
          rect: h.rect
        }))
      });
      return {
        content: [{ type: "text", text: markdown }],
        structuredContent: { hits }
      };
    }
  });
}
