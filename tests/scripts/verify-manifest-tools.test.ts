/**
 * Unit tests for `scripts/verify-manifest-tools.mjs`.
 *
 * Drives the verifier's exported helpers (`collectToolRegistrations`,
 * `checkAnnotations`, `runVerifier`) against synthetic source-file
 * inputs and synthetic project trees. The CLI wrapper at the bottom
 * of the script is not exercised here — `runVerifier()` is the
 * function that the CLI delegates to, and it never calls
 * `process.exit`, so we can test it in-process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  collectToolRegistrations,
  checkAnnotations,
  runVerifier,
  READ_ONLY_TOOLS,
  DESTRUCTIVE_TOOLS
  // @ts-expect-error - the verifier ships as .mjs without types
} from "../../scripts/verify-manifest-tools.mjs";

interface Registration {
  name: string;
  file: string;
  configBody: string;
}

function writeToolFile(toolsDir: string, file: string, contents: string): void {
  fs.writeFileSync(path.join(toolsDir, file), contents);
}

const READ_ONLY_TOOL_FIXTURE = `
import { defineOperatingTool } from "../define-operating-tool.js";

export function registerSearchExactTextTool(server: any, registry: any): void {
  defineOperatingTool<{ query: string }, { hits: { id: string }[] }>(server, registry, {
    name: "search_exact_text",
    title: "Search exact text",
    annotations: { readOnlyHint: true },
    description: "search",
    inputSchema: {},
    command: () => ({} as any),
    formatResult: () => ({ content: [], structuredContent: {} })
  });
}
`;

const DESTRUCTIVE_TOOL_FIXTURE = `
export function registerApplyAnnotationsTool(server: any) {
  return server.registerTool(
    "apply_annotations",
    {
      title: "Apply redactions",
      description: "burns redactions",
      inputSchema: {},
      annotations: { destructiveHint: true }
    },
    async () => ({ content: [] })
  );
}
`;

const NEUTRAL_TOOL_FIXTURE = `
export function registerCreateAnnotationTool(server: any, registry: any): void {
  defineOperatingTool<{ id: string }, { id: string }>(server, registry, {
    name: "create_annotation",
    title: "Create annotation",
    annotations: {},
    description: "create",
    inputSchema: {},
    command: () => ({} as any),
    formatResult: () => ({ content: [], structuredContent: {} })
  });
}
`;

const APP_TOOL_FIXTURE = `
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
export function registerOpenDocument(server: any) {
  return registerAppTool(
    server,
    "open_document",
    {
      title: "Open document",
      description: "opens a document",
      inputSchema: {},
      annotations: {},
      _meta: { ui: { resourceUri: "ui://x" } }
    },
    async () => ({ content: [] })
  );
}
`;

describe("verify-manifest-tools", () => {
  let tmpDir: string;
  let toolsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-manifest-"));
    toolsDir = path.join(tmpDir, "src", "mcp", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("collectToolRegistrations", () => {
    it("picks up defineOperatingTool registrations across generic type parameters", () => {
      writeToolFile(toolsDir, "search-exact-text.ts", READ_ONLY_TOOL_FIXTURE);
      const regs = collectToolRegistrations(toolsDir) as Registration[];
      expect(regs.map((r) => r.name)).toEqual(["search_exact_text"]);
      expect(regs[0]!.configBody).toContain("readOnlyHint: true");
      expect(regs[0]!.configBody).toContain('title: "Search exact text"');
    });

    it("picks up server.registerTool callsites", () => {
      writeToolFile(toolsDir, "apply-annotations.ts", DESTRUCTIVE_TOOL_FIXTURE);
      const regs = collectToolRegistrations(toolsDir) as Registration[];
      expect(regs.map((r) => r.name)).toEqual(["apply_annotations"]);
      expect(regs[0]!.configBody).toContain("destructiveHint: true");
    });

    it("picks up registerAppTool callsites", () => {
      writeToolFile(toolsDir, "open-document.ts", APP_TOOL_FIXTURE);
      const regs = collectToolRegistrations(toolsDir) as Registration[];
      expect(regs.map((r) => r.name)).toEqual(["open_document"]);
      expect(regs[0]!.configBody).toContain('title: "Open document"');
    });

    it("collects multiple tools from a single file (e.g. view-state.ts)", () => {
      writeToolFile(
        toolsDir,
        "view-state.ts",
        `
        export function registerViewStateTools(server: any) {
          const get = server.registerTool(
            "get_view_state",
            {
              title: "Get view state",
              description: "gv",
              inputSchema: {},
              annotations: { readOnlyHint: true }
            },
            async () => ({ content: [] })
          );
          const set = server.registerTool(
            "set_view_state",
            {
              title: "Set view state",
              description: "sv",
              inputSchema: {},
              annotations: {}
            },
            async () => ({ content: [] })
          );
          return [get, set];
        }
        `
      );
      const regs = collectToolRegistrations(toolsDir) as Registration[];
      expect(regs.map((r) => r.name).sort()).toEqual(["get_view_state", "set_view_state"]);
    });

    it("skips internal tools by name", () => {
      writeToolFile(
        toolsDir,
        "write-document-bytes.ts",
        `
        export function registerWriteDocumentBytes(server: any) {
          return server.registerTool(
            "write_document_bytes",
            { description: "internal" },
            async () => ({ content: [] })
          );
        }
        `
      );
      const regs = collectToolRegistrations(toolsDir) as Registration[];
      expect(regs).toEqual([]);
    });

    it("returns an empty array when toolsDir does not exist", () => {
      const missing = path.join(tmpDir, "no-such-dir");
      const regs = collectToolRegistrations(missing) as Registration[];
      expect(regs).toEqual([]);
    });
  });

  describe("checkAnnotations", () => {
    function regsFromFiles(files: Record<string, string>): Registration[] {
      for (const [file, contents] of Object.entries(files)) {
        writeToolFile(toolsDir, file, contents);
      }
      return collectToolRegistrations(toolsDir) as Registration[];
    }

    function buildAllSixteenWith(overrides: Record<string, string> = {}): Registration[] {
      // Minimal fixtures: every public tool registered with the right
      // shape, except for any per-test overrides.
      const fixtures: Record<string, string> = {
        "search-exact-text.ts": READ_ONLY_TOOL_FIXTURE,
        "read-document-information.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "search_exact_text",
          "read_document_information"
        ).replace("Search exact text", "Read document information"),
        "read-page-info.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "search_exact_text",
          "read_page_info"
        ).replace("Search exact text", "Read page info"),
        "get-page-image.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "search_exact_text",
          "get_page_image"
        ).replace("Search exact text", "Get page image"),
        "read-text.ts": READ_ONLY_TOOL_FIXTURE.replace("search_exact_text", "read_text").replace(
          "Search exact text",
          "Read text"
        ),
        "read-annotations.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "search_exact_text",
          "read_annotations"
        ).replace("Search exact text", "Read annotations"),
        "read-form-fields.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "search_exact_text",
          "read_form_fields"
        ).replace("Search exact text", "Read form fields"),
        "get-view-state.ts": `
          export function registerGetViewState(server: any) {
            return server.registerTool(
              "get_view_state",
              {
                title: "Get view state",
                description: "g",
                inputSchema: {},
                annotations: { readOnlyHint: true }
              },
              async () => ({ content: [] })
            );
          }
        `,
        "apply-annotations.ts": DESTRUCTIVE_TOOL_FIXTURE,
        "open-document.ts": APP_TOOL_FIXTURE,
        "close-document.ts": `
          export function registerCloseDocumentTool(server: any) {
            return server.registerTool(
              "close_document",
              {
                title: "Close document",
                description: "c",
                inputSchema: {},
                annotations: {}
              },
              async () => ({ content: [] })
            );
          }
        `,
        "set-view-state.ts": `
          export function registerSetViewState(server: any) {
            return server.registerTool(
              "set_view_state",
              {
                title: "Set view state",
                description: "s",
                inputSchema: {},
                annotations: {}
              },
              async () => ({ content: [] })
            );
          }
        `,
        "create-annotation.ts": NEUTRAL_TOOL_FIXTURE,
        "update-annotation.ts": NEUTRAL_TOOL_FIXTURE.replace(
          "create_annotation",
          "update_annotation"
        ).replace("Create annotation", "Update annotation"),
        "delete-annotation.ts": NEUTRAL_TOOL_FIXTURE.replace(
          "create_annotation",
          "delete_annotation"
        ).replace("Create annotation", "Delete annotation"),
        "update-form-field-values.ts": NEUTRAL_TOOL_FIXTURE.replace(
          "create_annotation",
          "update_form_field_values"
        ).replace("Create annotation", "Update form field values"),
        ...overrides
      };
      return regsFromFiles(fixtures);
    }

    it("passes when every public tool carries the expected annotations", () => {
      const regs = buildAllSixteenWith();
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.count).toBe(16);
    });

    it("flags a tool with a missing title", () => {
      const regs = buildAllSixteenWith({
        "search-exact-text.ts": READ_ONLY_TOOL_FIXTURE.replace(
          /title: "Search exact text",\n\s*/,
          ""
        )
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e: string) => e.includes("search_exact_text") && e.includes("missing `title`"))).toBe(true);
    });

    it("flags a tool with an empty title", () => {
      const regs = buildAllSixteenWith({
        "search-exact-text.ts": READ_ONLY_TOOL_FIXTURE.replace(
          'title: "Search exact text"',
          'title: ""'
        )
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e: string) => e.includes("search_exact_text") && e.includes("`title` is empty"))).toBe(true);
    });

    it("flags a read-only tool missing readOnlyHint: true", () => {
      const regs = buildAllSixteenWith({
        "search-exact-text.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "annotations: { readOnlyHint: true }",
          "annotations: {}"
        )
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e: string) =>
            e.includes("search_exact_text") && e.includes("`readOnlyHint: true`")
        )
      ).toBe(true);
    });

    it("flags apply_annotations missing destructiveHint: true", () => {
      const regs = buildAllSixteenWith({
        "apply-annotations.ts": DESTRUCTIVE_TOOL_FIXTURE.replace(
          "annotations: { destructiveHint: true }",
          "annotations: {}"
        )
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e: string) =>
            e.includes("apply_annotations") && e.includes("`destructiveHint: true`")
        )
      ).toBe(true);
    });

    it("flags a tool that mixes incompatible hints (read-only + destructive)", () => {
      const regs = buildAllSixteenWith({
        "search-exact-text.ts": READ_ONLY_TOOL_FIXTURE.replace(
          "annotations: { readOnlyHint: true }",
          "annotations: { readOnlyHint: true, destructiveHint: true }"
        )
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e: string) =>
            e.includes("search_exact_text") &&
            e.includes("read-only tool unexpectedly declares `destructiveHint: true`")
        )
      ).toBe(true);
    });

    it("flags a missing `annotations:` object entirely", () => {
      const regs = buildAllSixteenWith({
        "create-annotation.ts": NEUTRAL_TOOL_FIXTURE.replace(/annotations: \{\},\n\s*/, "")
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e: string) => e.includes("create_annotation") && e.includes("missing `annotations`")
        )
      ).toBe(true);
    });

    it("flags a contractually required read-only tool that's missing entirely", () => {
      // Drop `read_text` from the fixture set by stubbing its file with
      // an unrelated tool name so the registry collector doesn't pick
      // it up.
      const regs = buildAllSixteenWith({
        "read-text.ts": NEUTRAL_TOOL_FIXTURE.replace(
          "create_annotation",
          "some_other_tool"
        ).replace("Create annotation", "Other")
      });
      const result = checkAnnotations(regs);
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e: string) => e.startsWith("read_text:") && e.includes("no registration found")
        )
      ).toBe(true);
    });
  });

  describe("runVerifier (end-to-end)", () => {
    function buildSyntheticProject(
      rootDir: string,
      tools: Array<{ file: string; contents: string; manifestName?: string | null }>
    ): { manifestNames: string[] } {
      const toolsDir = path.join(rootDir, "src", "mcp", "tools");
      fs.mkdirSync(toolsDir, { recursive: true });
      for (const t of tools) {
        fs.writeFileSync(path.join(toolsDir, t.file), t.contents);
      }
      // Synthesize a server.ts whose allToolsRegistry.set(...) entries
      // mirror the public tools — the runVerifier logic checks
      // manifest vs. registry. Internal tools are skipped.
      const manifestNames = tools
        .map((t) => t.manifestName ?? extractName(t.contents))
        .filter((n): n is string => n !== null);
      const setLines = manifestNames
        .map((n) => `  allToolsRegistry.set("${n}", null as any);`)
        .join("\n");
      const serverTs = `// synthetic test fixture\nconst allToolsRegistry = new Map<string, unknown>();\n${setLines}\n`;
      fs.writeFileSync(path.join(rootDir, "src", "mcp", "server.ts"), serverTs);
      const manifest = {
        tools: manifestNames.map((name) => ({ name }))
      };
      fs.writeFileSync(path.join(rootDir, "manifest.json"), JSON.stringify(manifest, null, 2));
      return { manifestNames };
    }

    function extractName(contents: string): string | null {
      const m =
        /\bname:\s*["']([a-z][a-z0-9_]*)["']/.exec(contents) ||
        /(?:server\.tool|server\.registerTool)\s*\(\s*["']([a-z][a-z0-9_]*)["']/.exec(contents) ||
        /registerAppTool\s*\(\s*\w+\s*,\s*["']([a-z][a-z0-9_]*)["']/.exec(contents);
      return m ? m[1]! : null;
    }

    it("returns no errors against a well-formed synthetic project", () => {
      buildSyntheticProject(tmpDir, [
        { file: "search-exact-text.ts", contents: READ_ONLY_TOOL_FIXTURE },
        { file: "apply-annotations.ts", contents: DESTRUCTIVE_TOOL_FIXTURE },
        { file: "create-annotation.ts", contents: NEUTRAL_TOOL_FIXTURE }
      ]);
      // The contractually-required read-only set isn't fully covered
      // by this minimal project; `runVerifier` reports those as errors.
      // Filter them out to focus on the "no annotation drift" assertion.
      const { errors } = runVerifier(tmpDir);
      const annotationErrors = errors.filter(
        (e: string) => !e.endsWith("no registration found in src/mcp/tools/")
      );
      expect(annotationErrors).toEqual([]);
    });

    it("reports manifest-vs-registry drift", () => {
      buildSyntheticProject(tmpDir, [
        { file: "search-exact-text.ts", contents: READ_ONLY_TOOL_FIXTURE }
      ]);
      // Add an extra tool to the manifest that has no registration.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "manifest.json"), "utf8")
      );
      manifest.tools.push({ name: "ghost_tool" });
      fs.writeFileSync(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2));

      const { errors } = runVerifier(tmpDir);
      expect(errors.some((e: string) => e.includes("ghost_tool"))).toBe(true);
    });

    it("reports a missing manifest.json", () => {
      // Project layout exists but no manifest.
      fs.mkdirSync(path.join(tmpDir, "src", "mcp", "tools"), { recursive: true });
      const { errors } = runVerifier(tmpDir);
      expect(errors.some((e: string) => e.includes("manifest.json") && e.includes("not found"))).toBe(true);
    });
  });

  describe("contract sets", () => {
    it("READ_ONLY_TOOLS contains exactly the 8 read-only public tools", () => {
      expect([...READ_ONLY_TOOLS].sort()).toEqual(
        [
          "get_page_image",
          "get_view_state",
          "read_annotations",
          "read_document_information",
          "read_form_fields",
          "read_page_info",
          "read_text",
          "search_exact_text"
        ].sort()
      );
    });

    it("DESTRUCTIVE_TOOLS contains only apply_annotations", () => {
      expect([...DESTRUCTIVE_TOOLS]).toEqual(["apply_annotations"]);
    });
  });
});
