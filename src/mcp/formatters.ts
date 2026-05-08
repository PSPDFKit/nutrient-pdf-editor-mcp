/**
 * Markdown formatters for MCP tool responses.
 *
 * These render the same data that goes into `structuredContent` as a model-friendly
 * markdown blob in `content[0].text`. The split exists because MCP host clients
 * route the two channels differently:
 *   - MCP Apps hosts (e.g. Claude.ai with ext-apps) feed `content[].text` to the
 *     model and `structuredContent` to the iframe UI.
 *   - Direct stdio hosts (Claude Desktop, Claude Code) feed `structuredContent`
 *     to the model and may ignore `content[].text` entirely (claude-code#15412).
 *
 * Returning both — JSON-shaped structuredContent + a markdown render of the same
 * data — covers both routings.
 */

import type { Serializers } from "@nutrient-sdk/viewer";
// MCPFormField moved to src/contract/ to remove the mcp→viewer cross-import.
import type { MCPFormField } from "../contract/form-types.js";

export type { MCPFormField };

/**
 * Render an array of form fields as markdown with per-field hints.
 */
export function formatFormFields(fields: ReadonlyArray<MCPFormField>, pageIndex?: number): string {
  if (fields.length === 0) {
    const scope = pageIndex != null ? `page ${pageIndex}` : "the entire document";
    return `# Form Fields\n\nNo form fields found in ${scope}.`;
  }

  const lines: Array<string> = ["# Form Fields", ""];

  for (const field of fields) {
    const name = typeof field.name === "string" && field.name.length > 0 ? field.name : "Unknown";
    const label = typeof field.label === "string" && field.label.length > 0 ? field.label : name;
    const type = typeof field.type === "string" ? field.type : "Unknown";
    const typeShort = type.replace("pspdfkit/form-field/", "");
    const valueText = formatFieldValue(field.value);
    const required = isRequiredField(field) ? "Yes" : "No";

    lines.push(`## ${label}`);
    lines.push(`- **Identifier:** ${name}`);
    lines.push(`- **Type:** ${typeShort}`);
    lines.push(`- **Value:** ${valueText}`);
    lines.push(`- **Required:** ${required}`);

    const options = "options" in field ? field.options : undefined;
    if (Array.isArray(options) && options.length > 0) {
      const formatted = options.map((opt) => {
        const same = opt.label === opt.value;
        return same ? `"${opt.value}"` : `"${opt.value}" (${opt.label})`;
      });
      lines.push(`- **Options:** ${formatted.join(", ")}`);

      if (typeShort === "checkbox" || typeShort === "radio") {
        lines.push(
          '- **Note:** Use one of the options above to check, or pass null to uncheck (alternatively, some PDFs accept "Off" as an unchecked value)'
        );
      }
    }

    if ("multiSelect" in field && field.multiSelect === true) {
      lines.push("- **Multi-select:** Yes (pass an array of option values to select multiple)");
    }
    if (typeShort === "combobox" && "edit" in field && field.edit === true) {
      lines.push("- **Editable:** Yes (custom text allowed beyond the listed options)");
    }

    lines.push("");
  }

  lines.push(
    "---",
    "IMPORTANT: When referring to form fields in your responses, always use the field heading (label) shown above. Never expose the internal identifier to the user. Use identifiers only when calling internal tools."
  );

  return lines.join("\n");
}

/**
 * Render the current value of a form field for display.
 *
 * - `null` / `undefined` → "Not set"
 * - empty string → "(empty)"
 * - empty array → "(empty)"
 * - array of strings → comma-separated quoted values
 * - any other value → JSON-stringified
 */
function formatFieldValue(value: unknown): string {
  if (value == null) return "Not set";
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value.map((v) => `"${String(v)}"`).join(", ");
  }
  if (typeof value === "string") return value.length === 0 ? "(empty)" : value;
  return JSON.stringify(value);
}

/**
 * InstantJSON encodes "required" as an entry in the optional `flags` array.
 */
function isRequiredField(field: Serializers.FormFieldJSON): boolean {
  const flags = (field as { flags?: ReadonlyArray<string> }).flags;
  return Array.isArray(flags) && flags.includes("required");
}

/**
 * Render the success confirmation for `update_form_field_values`.
 *
 * Encourages the model to refer to fields by their human labels rather than
 * internal identifiers when reporting back to the user.
 */
export function formatFormFieldsUpdated(count: number): string {
  return `Successfully updated ${count} form field(s). Refer to the fields by their labels (not internal identifiers) when confirming changes to the user.`;
}

// ============================================================================
// Document / page / annotation / search formatters
// ============================================================================

export type DocumentInfoData = {
  pageCount?: number;
  title?: string;
  author?: string;
  permissions?: Record<string, boolean>;
};

export function formatDocumentInfo(data: DocumentInfoData): string {
  const title = data.title ?? "Unknown";
  const author = data.author ?? "Unknown";
  const pageCount = data.pageCount ?? "Unknown";

  const lines: Array<string> = [
    "# Document Information",
    "",
    `- **Title:** ${title}`,
    `- **Author:** ${author}`,
    `- **Pages:** ${pageCount}`
  ];

  if (data.permissions) {
    lines.push("", "## Permissions");
    for (const [key, value] of Object.entries(data.permissions)) {
      lines.push(`- **${key}**: ${value ? "allowed" : "not allowed"}`);
    }
  }

  return lines.join("\n");
}

export type PageInfoData = {
  pageIndex: number;
  width: number;
  height: number;
  rotation?: number;
};

export function formatPageInfo(data: PageInfoData): string {
  const { pageIndex, width, height, rotation } = data;
  return [
    `# Page ${pageIndex} Information`,
    "",
    `- **Width:** ${width} points`,
    `- **Height:** ${height} points`,
    `- **Rotation:** ${rotation ?? 0}°`,
    "",
    "Coordinates: points (1 pt = 1/72 in), origin at top-left, Y increases downward."
  ].join("\n");
}

/**
 * Annotation shape this formatter accepts. Matches the viewer-mcp's normalized
 * annotation shape: `{id, type, pageIndex, rect, contents}`. The `creatorName`
 * and `createdAt` fields are optional extras the formatter renders when present.
 *
 * `id`, `type`, and `pageIndex` are required — every annotation returned by the
 * viewer bridge carries them. `creatorName` and `createdAt` are optional because
 * the Nutrient SDK only populates them when the document has author metadata.
 */
export type AnnotationForFormatter = {
  id: string;
  type: string;
  pageIndex: number;
  creatorName?: string;
  createdAt?: string;
  contents?: string;
};

export function formatAnnotations(
  annotations: ReadonlyArray<AnnotationForFormatter>,
  pageIndex?: number,
  typeFilter?: string
): string {
  if (annotations.length === 0) {
    const scope = pageIndex != null ? `page ${pageIndex}` : "the entire document";
    const filterText = typeFilter ? ` with type "${typeFilter}"` : "";
    return `# Annotations\n\nNo annotations found in ${scope}${filterText}.`;
  }

  const lines: Array<string> = ["# Annotations", ""];

  for (const ann of annotations) {
    const id = ann.id;
    // Strip any InstantJSON namespace prefix; if the type is already short-form
    // (e.g. "highlight"), .split('/').pop() returns it unchanged.
    const rawType = ann.type.split("/").pop()!;
    const page = String(ann.pageIndex);
    const author = ann.creatorName ?? "Unknown";
    const created = ann.createdAt ?? "Unknown";
    const contents = extractAnnotationContents(ann);

    lines.push(`## Annotation ${id}`);
    lines.push(`- **Type:** ${rawType}`);
    lines.push(`- **Page:** ${page}`);
    if (ann.creatorName !== undefined) lines.push(`- **Author:** ${author}`);
    if (ann.createdAt !== undefined) lines.push(`- **Created:** ${created}`);
    if (contents) {
      lines.push("");
      lines.push("**Contents:**");
      lines.push("");
      lines.push(contents);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function extractAnnotationContents(ann: AnnotationForFormatter): string {
  // The viewer normalizes all annotation text to `contents` before bridging to
  // the server (see readAnnotations in src/viewer/main.ts). Other fields that
  // InstantJSON defines (note, text, text.value) are not produced by this MCP's
  // bridge layer and are omitted from the type.
  if (typeof ann.contents === "string" && ann.contents.length > 0) return ann.contents;
  return "";
}

export type TextSearchHit = {
  pageIndex: number;
  previewText?: string;
  rect: { left: number; top: number; width: number; height: number };
};

export type TextSearchResultData = {
  searchTerm?: string;
  hits: ReadonlyArray<TextSearchHit>;
};

export function formatTextSearchResults(data: TextSearchResultData): string {
  const term = data.searchTerm ?? "";
  const total = data.hits.length;

  if (total === 0) {
    return `# Text Search Results\n\nNo matches found${term ? ` for "${term}"` : ""}.`;
  }

  const lines: Array<string> = ["# Text Search Results", ""];
  if (term) lines.push(`**Search term:** "${term}"`);
  lines.push(`**Total matches:** ${total}`, "");

  for (let i = 0; i < data.hits.length; i++) {
    const match = data.hits[i]!;
    lines.push(`## Match ${i + 1}`);
    lines.push(`- **Page:** ${match.pageIndex}`);
    if (match.previewText) lines.push(`- **Preview:** "${match.previewText}"`);
    lines.push("");
    lines.push("**Rect:**");
    lines.push(
      `- left: ${match.rect.left.toFixed(2)}, top: ${match.rect.top.toFixed(2)}, width: ${match.rect.width.toFixed(2)}, height: ${match.rect.height.toFixed(2)}`
    );
    lines.push("");
  }

  return lines.join("\n");
}

export function formatPageImageMetadata(
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
  renderedWidth: number
): string {
  const pixelToPdfScale = pageWidth / renderedWidth;
  return `Page ${pageIndex} dimensions:
- Page size: ${pageWidth.toFixed(2)} × ${pageHeight.toFixed(2)} points
- Rendered image size: ${renderedWidth} pixels wide (aspect ratio preserved)
- Scale factor: ${pixelToPdfScale.toFixed(4)} points per pixel

To convert pixel coordinates to point coordinates:
1. pointX = pixelX × ${pixelToPdfScale.toFixed(4)}
2. pointY = pixelY × ${pixelToPdfScale.toFixed(4)}
   (Origin at top-left, Y increases downward — same as image pixels)`;
}
