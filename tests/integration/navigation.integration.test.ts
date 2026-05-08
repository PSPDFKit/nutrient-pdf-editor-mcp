/**
 * Integration tests for navigation tools (AC2.2, AC2.3, AC2.6)
 * Tests the tool chain: open_document → get_view_state → set_view_state → search_exact_text
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MCPClient } from "./mcp-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const fixturesDir = path.join(projectRoot, "tests/fixtures");

describe("navigation integration test", () => {
  let client: MCPClient;

  beforeEach(async () => {
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

  afterEach(() => {
    client.close();
  });

  async function pollAndRespond(
    viewUUID: string,
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

      if (pollData.commands.length > 0) {
        const cmd = pollData.commands[0];
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

      await new Promise((r) => setTimeout(r, pollInterval));
    }

    expect(requestId.length > 0).toBe(true);
    return requestId;
  }

  it("viewer-mcp.AC2.2: get_view_state returns document state shape", { timeout: 15000 }, async () => {
    const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");

    // Open document — open_document mints a fresh viewUUID per call.
    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });
    expect(openRes.result!.structuredContent).toBeDefined();
    const viewUUID: string = openRes.result!.structuredContent.viewUUID;

    // Now call get_view_state
    const getStatePromise = client.send({
      method: "tools/call",
      params: {
        name: "get_view_state",
        arguments: {}
      }
    });

    await pollAndRespond(viewUUID, {
      documentPath: fixturePath,
      pageCount: 3,
      activePage: 0
    });

    const getStateRes = await getStatePromise;
    expect(getStateRes.result!.structuredContent).toBeDefined();

    const state = getStateRes.result!.structuredContent as any;
    expect(state).toHaveProperty("documentPath");
    expect(state).toHaveProperty("pageCount");
    expect(state).toHaveProperty("activePage");
    expect(typeof state.pageCount).toBe("number");
    expect(typeof state.activePage).toBe("number");
  });

  it("viewer-mcp.AC2.3: set_view_state navigates to new page", { timeout: 15000 }, async () => {
    const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");

    // Open document — open_document mints a fresh viewUUID per call.
    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });
    const viewUUID: string = openRes.result!.structuredContent.viewUUID;

    // Call set_view_state to navigate to page 2
    const setStatePromise = client.send({
      method: "tools/call",
      params: {
        name: "set_view_state",
        arguments: { activePage: 2 }
      }
    });

    await pollAndRespond(viewUUID, {
      documentPath: fixturePath,
      pageCount: 3,
      activePage: 2
    });

    const setStateRes = await setStatePromise;
    expect(setStateRes.result!.structuredContent).toBeDefined();

    const newState = setStateRes.result!.structuredContent as any;
    expect(newState.activePage).toBe(2);
  });

  it("viewer-mcp.AC2.6: search_exact_text and set_view_state round-trip with scroll rect", { timeout: 15000 }, async () => {
    const fixturePath = path.join(projectRoot, "tests/fixtures/sample.pdf");

    // Open document — open_document mints a fresh viewUUID per call.
    const openRes = await client.send({
      method: "tools/call",
      params: {
        name: "open_document",
        arguments: { path: fixturePath }
      }
    });
    const viewUUID: string = openRes.result!.structuredContent.viewUUID;

    // Search for text
    const searchPromise = client.send({
      method: "tools/call",
      params: {
        name: "search_exact_text",
        arguments: { query: "test" }
      }
    });

    const hitRect = { left: 10, top: 20, width: 100, height: 15 };
    await pollAndRespond(viewUUID, {
      hits: [
        {
          hitId: "hit-1",
          pageIndex: 1,
          rect: hitRect,
          snippet: "test content"
        }
      ]
    });

    const searchRes = await searchPromise;
    expect(searchRes.result!.structuredContent).toBeDefined();

    const hits = searchRes.result!.structuredContent as any;
    expect(Array.isArray(hits.hits)).toBe(true);
    expect(hits.hits.length).toBeGreaterThan(0);

    const firstHit = hits.hits[0];
    expect(firstHit).toHaveProperty("hitId");
    expect(firstHit).toHaveProperty("pageIndex");
    expect(firstHit).toHaveProperty("rect");

    // Now scroll to the hit location using set_view_state
    const setStatePromise = client.send({
      method: "tools/call",
      params: {
        name: "set_view_state",
        arguments: {
          scrollTo: {
            pageIndex: firstHit.pageIndex,
            rect: firstHit.rect
          }
        }
      }
    });

    await pollAndRespond(viewUUID, {
      documentPath: fixturePath,
      pageCount: 3,
      activePage: firstHit.pageIndex,
      scrollPosition: { x: firstHit.rect.left, y: firstHit.rect.top }
    });

    const setStateRes = await setStatePromise;
    expect(setStateRes.result!.structuredContent).toBeDefined();

    const finalState = setStateRes.result!.structuredContent as any;
    expect(finalState.activePage).toBe(1);
  });
});
