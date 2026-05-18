import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCPClient } from "../integration/mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

describe("capabilities", () => {
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

  it("server declares the tools capability", async () => {
    // Advertise the MCP Apps UI capability so the init-time gate in
    // `src/mcp/require-ui-capability.ts` accepts the connection. Without
    // it, `initialize` is rejected with InvalidRequest — see
    // `init-rejection.test.ts` for that path.
    const initRes = await client.send({
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"]
            }
          }
        },
        clientInfo: { name: "test", version: "1.0" }
      }
    });

    expect(initRes.result).toBeDefined();
    expect(initRes.result!.capabilities).toBeDefined();
    expect(initRes.result!.capabilities.tools).toBeDefined();
    // The MCP SDK auto-declares listChanged whenever tools are registered, so
    // we cannot opt out of the capability flag. The invariant we actually
    // enforce is that no notifications/tools/list_changed messages are ever
    // emitted — see lifecycle.integration.test.ts for that assertion.
  });
});
