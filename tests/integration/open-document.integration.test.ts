import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCPClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

describe("open-document integration test (fast-return contract)", () => {
  let client: MCPClient;

  beforeAll(async () => {
    const distPath = path.join(projectRoot, "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
    client = new MCPClient(fixturesDir);
    await client.initialize();
  });

  afterAll(() => {
    client.close();
  });

  it("open_document returns {documentPath, viewUUID} immediately with _meta.ui.resourceUri", async () => {
    const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");
    expect(fs.existsSync(fixturePath)).toBe(true);

    // open_document mints a FRESH viewUUID per call (the multi-conversation
    // close-broadcast in option (C) needs each open to roll the active
    // viewUUID so the prior iframe can be addressed for its `close_document`
    // command). Open twice and verify the two viewUUIDs differ.
    const firstOpen = await client.send({
      method: "tools/call",
      params: { name: "open_document", arguments: { path: fixturePath } }
    });
    const firstViewUUID = (firstOpen.result!.structuredContent as { viewUUID: string }).viewUUID;
    expect(firstViewUUID.length).toBeGreaterThan(0);

    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });

    expect(openRes.result).toBeDefined();
    const newViewUUID = (openRes.result!.structuredContent as { viewUUID: string })
      .viewUUID;
    expect(typeof newViewUUID).toBe("string");
    expect(newViewUUID.length).toBeGreaterThan(0);
    expect(newViewUUID).not.toBe(firstViewUUID);

    expect(openRes.result!.structuredContent).toEqual({
      documentPath: fixturePath,
      viewUUID: newViewUUID
    });
    expect(openRes.result!._meta!.viewUUID).toBe(newViewUUID);
    expect((openRes.result!._meta!.ui as { resourceUri: string }).resourceUri).toBe(
      "ui://nutrient-viewer/mcp-app.html"
    );
  });
});
