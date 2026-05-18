import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCPClient } from "../integration/mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

describe("tool-registry", () => {
  let client: MCPClient;

  beforeAll(() => {
    const distPath = path.join(projectRoot, "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
    client = new MCPClient(fixturesDir);
  });

  afterAll(() => {
    client.close();
  });

  // Alphabetical order — the SDK serialises `tools/list` sorted.
  const EXPECTED_PUBLIC_TOOLS = [
    "apply_annotations",
    "close_document",
    "create_annotation",
    "delete_annotation",
    "get_page_image",
    "get_view_state",
    "open_document",
    "read_annotations",
    "read_document_information",
    "read_form_fields",
    "read_page_info",
    "read_text",
    "search_exact_text",
    "set_view_state",
    "update_annotation",
    "update_form_field_values"
  ];

  it("fresh server boot returns the full public tool surface (no gating)", async () => {
    const listRes = await client.send({
      method: "tools/list",
      params: {}
    });

    expect(listRes.result).toBeDefined();
    expect(listRes.result!.tools).toBeDefined();
    const toolNames = (listRes.result!.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(toolNames).toEqual(EXPECTED_PUBLIC_TOOLS);
  });

  it("internal tools are filtered from tools/list", async () => {
    const listRes = await client.send({
      method: "tools/list",
      params: {}
    });

    const toolNames = (listRes.result!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(toolNames).not.toContain("poll_commands");
    expect(toolNames).not.toContain("submit_response");
  });

  it("tools/list is unchanged after open_document — runtime guards do the gating", async () => {
    // Create a fresh client for clean state
    const freshClient = new MCPClient(fixturesDir);

    try {
      // Initialize (advertises roots so path-guard accepts paths under fixturesDir).
      const initRes = await freshClient.initialize();
      expect(initRes.result).toBeDefined();

      // List before open - the full public surface is always advertised.
      const listBeforeRes = await freshClient.send({
        method: "tools/list",
        params: {}
      });
      const toolsBeforeNames = (listBeforeRes.result!.tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(toolsBeforeNames).toEqual(EXPECTED_PUBLIC_TOOLS);

      // Open a document
      const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");
      const openRes = await freshClient.send({
        method: "tools/call",
        params: {
          name: "open_document",
          arguments: { path: fixturePath }
        }
      });
      expect(openRes.result).toBeDefined();
      expect(openRes.result!.structuredContent).toBeDefined();
      expect(openRes.result!.structuredContent.documentPath).toBe(fixturePath);

      // After open_document succeeds, tools/list returns the same set.
      const listAfterRes = await freshClient.send({
        method: "tools/list",
        params: {}
      });
      expect(listAfterRes.result).toBeDefined();
      const toolsAfterNames = (listAfterRes.result!.tools as Array<{ name: string }>).map((t) => t.name).sort();
      expect(toolsAfterNames).toEqual(EXPECTED_PUBLIC_TOOLS);
    } finally {
      freshClient.close();
    }
  });
});
