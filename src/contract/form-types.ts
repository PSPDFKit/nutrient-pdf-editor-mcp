/**
 * Form field shape returned by `read_form_fields`.
 *
 * Moved from src/viewer/form-types.ts to src/contract/ so that both
 * src/mcp/ (formatters, read-form-fields) and src/viewer/ (form-operations)
 * can reference it without creating cross-layer imports between those two
 * target-specific directories.
 *
 * Uses `import type` only — the SDK import is purely for the TypeScript
 * Serializers type, no runtime import occurs.
 */
import type { Serializers } from "@nutrient-sdk/viewer";

/**
 * The canonical form-field record this MCP returns.
 *
 * - Discriminated by `type` (e.g. `"pspdfkit/form-field/checkbox"`).
 * - `value` / `values` are the current runtime values from
 *   `instance.getFormFieldValues()` — `value` is single-string for non-array
 *   fields, `values` mirrors arrays for backward compat with consumers that
 *   look at either.
 * - `pageIndex` and `rect` describe the widget annotation's position on the
 *   page. This MCP runs as a separate process from the viewer, so the model
 *   needs them to know where the field is rendered.
 */
export type MCPFormField = Serializers.FormFieldJSON & {
  value?: unknown;
  values?: ReadonlyArray<string>;
  pageIndex?: number;
  rect?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};
