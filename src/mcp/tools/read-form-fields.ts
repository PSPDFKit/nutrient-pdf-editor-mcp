import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
// MCPFormField moved to src/contract/ to remove the mcp→viewer cross-import.
import type { MCPFormField } from "../../contract/form-types.js";
import { formatFormFields } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";

export function registerReadFormFields(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<{ pageIndex?: number }, { fields: MCPFormField[] }>(
    server,
    allToolsRegistry,
    {
      name: "read_form_fields",
      title: "Read form fields",
      annotations: { readOnlyHint: true },
      description:
        "Use when discovering what fields a form has before filling it — onboarding packet, application, signature page, tax form, vendor questionnaire. Returns the form schema (each field's name, type discriminator, options with labels, current value, multi-select flag for choice fields, and per-widget position). Pair with update_form_field_values to fill them. Optionally scope to a single page.",
      inputSchema: {
        pageIndex: z.number().int().nonnegative().optional()
      },
      command: (input, requestId) => ({
        type: "read_form_fields",
        requestId,
        ...(input.pageIndex !== undefined && { pageIndex: input.pageIndex })
      }),
      // Markdown render goes into content[0].text — primary channel for MCP
      // Apps hosts (Claude.ai/ext-apps) per the apps spec. structuredContent
      // carries the same data as JSON for hosts that route the structured
      // channel to the model instead (Claude Code per claude-code#15412).
      formatResult: (input, payload, _viewUUID) => ({
        content: [{ type: "text", text: formatFormFields(payload.fields, input.pageIndex) }],
        structuredContent: { fields: payload.fields }
      })
    }
  );
}
