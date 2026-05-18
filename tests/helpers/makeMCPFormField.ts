/**
 * H4: makeMCPFormField — factory for MCPFormField test fixtures.
 *
 * Provides sensible defaults for a text form field (the most common type used
 * in formatter tests). Pass overrides to customise any property, including
 * switching the discriminated `type` to produce checkbox / radio / etc.
 *
 * Because MCPFormField is a large discriminated union the return is cast via
 * `as MCPFormField`, matching what formatters.test.ts already does inline.
 */

import type { MCPFormField } from "../../src/mcp/formatters.js";

/** Default values for a minimal text form field. */
const TEXT_DEFAULTS = {
  v: 1 as const,
  type: "pspdfkit/form-field/text" as const,
  id: "field-id",
  pdfObjectId: 1,
  name: "field.name",
  annotationIds: [] as string[],
  label: "Field Label",
  additionalActions: undefined,
  password: false,
  doNotScroll: false,
  multiLine: false,
  defaultValue: "",
  comb: false,
  doNotSpellCheck: false,
} as const;

/**
 * Create an MCPFormField fixture with merged overrides.
 *
 * @param overrides - Shallow-merge onto the text-field defaults. To produce a
 *   non-text type, include `type` in overrides and add any required extra
 *   fields (e.g. `options` for checkbox/radio).
 */
export function makeMCPFormField(overrides: Partial<Record<string, unknown>> = {}): MCPFormField {
  return { ...TEXT_DEFAULTS, ...overrides } as unknown as MCPFormField;
}
