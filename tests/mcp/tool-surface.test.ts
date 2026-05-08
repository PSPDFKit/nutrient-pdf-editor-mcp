/**
 * AC9.5: Tool surface naming and static validation
 * Verifies tool naming convention and basic structure
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(__dirname, "../../src/mcp/tools");

describe("tool surface (AC9.5)", () => {
  it("all public tool files export a register function", () => {
    // Read all tool files (except types and index)
    const files = fs
      .readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith(".") && f !== "index.ts" && f !== "annotation-types.ts");

    // Check that each tool file exports a register function
    const registerFunctions = files.filter((file) => {
      const content = fs.readFileSync(path.join(toolsDir, file), "utf-8");
      // Every tool file should have an export function registerXTool
      return /export\s+function\s+register\w+Tool/.test(content) || /export\s+function\s+register\w+/.test(content);
    });

    // Should have substantial coverage (13 or more tool files with register functions)
    expect(registerFunctions.length).toBeGreaterThanOrEqual(13);
  });

  it("public tool files register bare snake_case tool names (no host-redundant prefix)", () => {
    // The MCP host already namespaces tools as `mcp__<server>__<tool>`, so
    // public tool names must NOT carry their own redundant prefix. Verify
    // each user-facing tool file registers a snake_case bare name through
    // one of the four registration paths.
    const serverFiles = fs
      .readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith(".") && f !== "index.ts");

    const REGISTRATION_PATTERNS = [
      /server\.tool\s*\(\s*["'](?<name>[a-z][a-z0-9_]*)["']/,
      /server\.registerTool\s*\(\s*["'](?<name>[a-z][a-z0-9_]*)["']/,
      /registerAppTool\s*\([\s\S]*?["'](?<name>[a-z][a-z0-9_]*)["']/,
      /defineOperatingTool\s*[\s\S]*?["'](?<name>[a-z][a-z0-9_]*)["']/,
    ];

    // Internal viewer-only tools are filtered out of `tools/list` and use
    // bridge-internal names that never appeared on the public surface —
    // exclude alongside the type-only / index files.
    const INTERNAL_TOOL_FILES = new Set(["write-document-bytes.ts"]);
    const userFacingTools = serverFiles.filter(
      (f) =>
        f !== "annotation-types.ts" &&
        f !== "index.ts" &&
        !INTERNAL_TOOL_FILES.has(f),
    );

    // Reject any tool name beginning with the previously-removed redundant
    // prefix. Built dynamically so this assertion can never accidentally be
    // sed-rewritten away in a future global rename.
    const FORBIDDEN_PREFIX = ["nutrient", "pdf", "editor"].join("_") + "_";

    // Public tool names registered as of the bare-name cutover. Catches any
    // accidental drift from the public surface (e.g. someone resurrects a
    // prefixed name or invents a new shape).
    const ALLOWED_PUBLIC_NAMES = new Set([
      "open_document",
      "close_document",
      "get_view_state",
      "set_view_state",
      "search_exact_text",
      "read_document_information",
      "read_page_info",
      "get_page_image",
      "read_text",
      "create_annotation",
      "read_annotations",
      "update_annotation",
      "delete_annotation",
      "apply_annotations",
      "read_form_fields",
      "update_form_field_values",
    ]);

    for (const file of userFacingTools) {
      const content = fs.readFileSync(path.join(toolsDir, file), "utf-8");
      const registered = REGISTRATION_PATTERNS.map((re) => re.exec(content)?.groups?.name).find(
        (name) => Boolean(name),
      );
      expect(registered, `${file} should register a snake_case tool name`).toBeDefined();
      expect(registered!.startsWith(FORBIDDEN_PREFIX), `${file} registered "${registered}" — public tool names must not carry the host-redundant prefix`).toBe(false);
      expect(ALLOWED_PUBLIC_NAMES.has(registered!), `${file} registered "${registered}" — not in the known public-tool name set`).toBe(true);
    }
  });

  it("key tools have expected structure in their schemas", () => {
    // Check that open-document has path parameter
    const openDocContent = fs.readFileSync(
      path.join(toolsDir, "open-document.ts"),
      "utf-8"
    );
    expect(openDocContent).toContain("path");
    expect(openDocContent).toContain("z.string");

    // Check that search-exact-text has query parameter
    const searchContent = fs.readFileSync(
      path.join(toolsDir, "search-exact-text.ts"),
      "utf-8"
    );
    expect(searchContent).toContain("query");
    expect(searchContent).toContain("z.string");

    // update-form-field-values takes a discriminated array with per-type
    // value shape, not a flat record. The InstantJSON-aligned shape lets the
    // model express null clears and array values for multi-select fields.
    const updateContent = fs.readFileSync(
      path.join(toolsDir, "update-form-field-values.ts"),
      "utf-8"
    );
    expect(updateContent).toContain("formFieldValues");
    expect(updateContent).toContain("z.array");
    // The value field is `string | string[] | null` so a union must appear
    // somewhere in the schema. Match across whitespace because zod chains can
    // straddle line breaks (z\n  .union(...)).
    expect(updateContent).toMatch(/\.union\s*\(/);
  });
});
