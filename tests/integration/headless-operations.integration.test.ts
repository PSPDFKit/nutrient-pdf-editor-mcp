import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MCPClient } from "./mcp-client.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

describe("headless-operations integration test (AC5.3): operating tools succeed against headless instance", () => {
  let client: MCPClient;

  beforeAll(async () => {
    const distPath = path.join(projectRoot, "dist/index.js");
    if (!fs.existsSync(distPath)) {
      throw new Error(
        `dist/index.js not found. Run \`npm run build\` before executing integration tests.\n` +
        `Expected at: ${distPath}`
      );
    }
    client = new MCPClient(fixturesDir, { LONG_POLL_TIMEOUT_MS: "200" });
    await client.initialize();
  });

  afterAll(() => {
    client.close();
  });

  /**
   * Helper to poll for commands and submit a stubbed response.
   * Simulates what the real iframe does: poll, check for pending commands, respond.
   */
  async function pollAndRespond(
    viewUUID: string,
    expectedCommandType: string,
    response: any
  ): Promise<string> {
    const pollTimeout = 3000;
    const pollInterval = 100;
    let requestId = "";
    const startTime = Date.now();

    while (Date.now() - startTime < pollTimeout && !requestId) {
      const pollRes = await client.send({
        method: "tools/call",
        params: {
          name: "poll_commands",
          arguments: { viewUUID }
        }
      });

      const pollContent = pollRes.result!.content?.[0]?.text;
      const pollData = JSON.parse(pollContent!);

      if (pollData.commands && pollData.commands.length > 0) {
        const cmd = pollData.commands[0];
        if (cmd.type === expectedCommandType) {
          requestId = cmd.requestId;

          await client.send({
            method: "tools/call",
            params: {
              name: "submit_response",
              arguments: {
                requestId,
                data: response
              }
            }
          });
          break;
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    expect(requestId.length > 0).toBe(true);
    return requestId;
  }

  it("AC5.3: operating tool round-trip succeeds with headless instance", { timeout: 15000 }, async () => {
    const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");
    expect(fs.existsSync(fixturePath)).toBe(true);

    // Step 1: Open document. open_document mints a FRESH viewUUID per call
    // (the multi-conversation close-broadcast in option (C) needs each open
    // to roll the active viewUUID). Subsequent operating tools target this
    // new viewUUID, so capture it for use in `pollAndRespond` below.
    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });
    expect(openRes.result!.structuredContent.documentPath).toBe(fixturePath);
    const viewUUID: string = openRes.result!.structuredContent.viewUUID;
    expect(viewUUID.length).toBeGreaterThan(0);

    // Step 2: Call an operating tool (read_document_information) without awaiting
    // This enqueues the command for the iframe
    const readDocPromise = client.send({
      method: "tools/call",
      params: {
        name: "read_document_information",
        arguments: {}
      }
    });

    // Step 3: Simulate iframe polling and responding to the queued command
    // The iframe would poll, see read_document_information, fetch the stub response
    const stubDocInfo = {
      pageCount: 3,
      title: "Sample Document",
      permissions: {
        annotationsAndForms: true,
        assemble: true,
        extract: true,
        extractAccessibility: true,
        fillForms: true,
        modification: true,
        printHighQuality: true,
        printing: true
      }
    };

    const requestId = await pollAndRespond(
      viewUUID,
      "read_document_information",
      stubDocInfo
    );

    expect(requestId.length).toBeGreaterThan(0);

    // Step 4: Await the original read_document_information call
    // It should now complete with the stubbed response
    const readDocRes = await readDocPromise;
    expect(readDocRes.result!.structuredContent).toBeDefined();

    const result = readDocRes.result!.structuredContent as any;
    expect(result.pageCount).toBe(3);
    expect(result.title).toBe("Sample Document");
    expect(result.permissions).toBeDefined();
    expect(result.permissions.annotationsAndForms).toBe(true);
  });
});
