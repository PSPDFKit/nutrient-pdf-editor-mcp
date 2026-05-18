import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatFormFieldsUpdated } from "../formatters.js";
import { defineOperatingTool } from "../define-operating-tool.js";

type FormFieldUpdate = { name: string; value: string | string[] | null };
type UpdateFormFieldPayload = {
  updated: FormFieldUpdate[];
  unresolved: Array<{ name: string; reason: string }>;
};
type UpdateFormFieldInput = { formFieldValues: FormFieldUpdate[] };

function formatPostValue(value: string | string[] | null): string {
  if (value === null) return "(cleared)";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value.map((v) => `"${v}"`).join(", ");
  }
  return value.length === 0 ? "(empty)" : `"${value}"`;
}

export function registerUpdateFormFieldValues(
  server: McpServer,
  allToolsRegistry?: Map<string, RegisteredTool>
): void {
  defineOperatingTool<UpdateFormFieldInput, UpdateFormFieldPayload>(server, allToolsRegistry, {
    name: "update_form_field_values",
    title: "Update form field values",
    annotations: {},
    description:
      "Use when filling out a form — onboarding packet, application, vendor form, tax form, signature page. Call read_form_fields first to discover field names, types, and valid options. The schema is the contract; per-field hints (accepted value shape, available options, multi-select flag) come from read_form_fields, not from this description. Returns which fields were updated and which could not be resolved.",
    inputSchema: {
      formFieldValues: z
        .array(
          z.object({
            name: z
              .string()
              .describe(
                "Exact form field name as returned by read_form_fields. Case-sensitive; the fully qualified PDF field name."
              ),
            value: z
              .union([z.string(), z.array(z.string()), z.null()])
              .describe(
                "The value to set. For text fields: string, or null to clear. For checkboxes: array of option names to check (e.g., [\"Yes\"]), or null to uncheck. For radio buttons: string with the option's value, or null to deselect. For combo boxes / list boxes: string for single-select, string[] for multi-select (per the field's multiSelect flag), or null. For combobox with edit:true: any custom string is allowed. Always call read_form_fields first to see the available options."
              )
          })
        )
        .min(1)
        .describe(
          "Array of form-field updates to apply. Each entry must specify the exact field name and the new value. Multiple fields can be updated in a single call."
        )
    },
    command: (input, requestId) => ({
      type: "update_form_field_values",
      requestId,
      formFieldValues: input.formFieldValues
    }),
    formatResult: (_input, payload, _viewUUID) => {
      // Markdown summary in content[0].text. Each updated entry surfaces its
      // post-write value so the agent can verify the field state without a
      // follow-up read_form_fields call. Hosts that consume only
      // structuredContent (e.g. Claude Code per claude-code#15412) still get
      // the same data via the structured channel.
      const lines: string[] = [formatFormFieldsUpdated(payload.updated.length)];
      if (payload.updated.length > 0) {
        lines.push("", "Now set to:");
        for (const u of payload.updated) {
          lines.push(`- ${u.name}: ${formatPostValue(u.value)}`);
        }
      }
      if (payload.unresolved.length > 0) {
        lines.push("", "Unresolved:");
        for (const u of payload.unresolved) {
          lines.push(`- ${u.name}: ${u.reason}`);
        }
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { updated: payload.updated, unresolved: payload.unresolved }
      };
    }
  });
}
