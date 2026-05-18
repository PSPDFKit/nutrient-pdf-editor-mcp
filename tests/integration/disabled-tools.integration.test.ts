import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCPClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

describe("operating tools without an open document return a guard error", () => {
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

  it(
    "calling an operating tool pre-open returns -32602 with 'no document is currently open'",
    { timeout: 15000 },
    async () => {
      const initRes = await client.initialize();
      expect(initRes.result).toBeDefined();

      const response = await client.send({
        method: "tools/call",
        params: {
          name: "read_document_information",
          arguments: {}
        }
      });

      // Runtime guard surfaces as a JSON-RPC error or as result.isError depending
      // on SDK version; accept either shape but require the guard message.
      if (response.error) {
        expect(response.error.code).toBe(-32602);
        expect(response.error.message).toMatch(/no document is currently open/i);
      } else if (response.result && response.result.isError) {
        const errorText = response.result.content[0]?.text || "";
        expect(errorText).toMatch(/no document is currently open/i);
      } else {
        throw new Error(
          `Expected guard error but got: ${JSON.stringify(response, null, 2)}`
        );
      }
    }
  );

  it(
    "calling close_document pre-open returns success {closed: true} (idempotent no-op)",
    { timeout: 15000 },
    async () => {
      const response = await client.send({
        method: "tools/call",
        params: {
          name: "close_document",
          arguments: {}
        }
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      expect(response.result.isError).toBeFalsy();
      expect(response.result.structuredContent).toEqual({ closed: true });
    }
  );
});
