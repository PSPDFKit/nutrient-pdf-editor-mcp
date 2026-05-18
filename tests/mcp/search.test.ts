import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { registerSearchExactTextTool } from "../../src/mcp/tools/search-exact-text.js";
import { assertPlainJson } from "../helpers/assertPlainJson.js";
import { flushMicrotasks } from "../helpers/mcpTestClient.js";
import { createSessionFixture, type SessionFixture } from "../helpers/sessionFixture.js";

describe("search_exact_text", () => {
  let fixture: SessionFixture;

  beforeEach(async () => {
    fixture = await createSessionFixture([registerSearchExactTextTool]);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("viewer-mcp.AC2.4: search_exact_text returns array of {hitId, pageIndex, rect, snippet}", async () => {
    const { callTool } = fixture;
    const { viewUUID: sessionUUID } = sessionModule.getSession();

    const resultPromise = callTool("search_exact_text", {
      query: "confidentiality"
    });

    await flushMicrotasks();

    const commands = sessionModule.drain();
    expect(commands.length).toBe(1);
    expect(commands[0]!.type).toBe("search_exact_text");
    expect((commands[0]! as any).query).toBe("confidentiality");
    const requestId = (commands[0]! as any).requestId;

    // Simulate viewer response with hits
    sessionModule.resolvePending(requestId, {
      hits: [
        {
          hitId: `hit-${requestId}-0`,
          pageIndex: 1,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          snippet: "...confidentiality clause..."
        },
        {
          hitId: `hit-${requestId}-1`,
          pageIndex: 3,
          rect: { left: 50, top: 100, width: 200, height: 15 },
          snippet: "...confidentiality agreement..."
        }
      ]
    });

    const result = await resultPromise;

    // Verify structure
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("structuredContent");
    expect(result).toHaveProperty("_meta");

    // Verify structuredContent
    expect(result.structuredContent).toEqual({
      hits: [
        {
          hitId: expect.stringContaining("hit-"),
          pageIndex: 1,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          snippet: "...confidentiality clause..."
        },
        {
          hitId: expect.stringContaining("hit-"),
          pageIndex: 3,
          rect: { left: 50, top: 100, width: 200, height: 15 },
          snippet: "...confidentiality agreement..."
        }
      ],
      viewUUID: sessionUUID
    });

    // Verify _meta.viewUUID
    expect(result._meta).toEqual({ viewUUID: sessionUUID });

    // AC9.1: Verify response is plain JSON
    assertPlainJson(result.structuredContent);

    // content[0].text is now a markdown render of the search results.
    const contentText = (result.content[0] as any).text;
    expect(contentText).toContain("# Text Search Results");
    expect(contentText).toContain("**Total matches:** 2");
    expect(sessionUUID).toBeTruthy();
  });

  it("viewer-mcp.AC2.5: search_exact_text with pageIndex restricts to single page", async () => {
    const { callTool } = fixture;

    const resultPromise = callTool("search_exact_text", {
      query: "search term",
      pageIndex: 2
    });

    await flushMicrotasks();

    const commands = sessionModule.drain();
    expect(commands.length).toBe(1);
    expect(commands[0]!.type).toBe("search_exact_text");
    expect((commands[0]! as any).query).toBe("search term");
    expect((commands[0]! as any).pageIndex).toBe(2);
    const requestId = (commands[0]! as any).requestId;

    // Simulate viewer response with single-page hits
    sessionModule.resolvePending(requestId, {
      hits: [
        {
          hitId: `hit-${requestId}-0`,
          pageIndex: 2,
          rect: { left: 10, top: 20, width: 100, height: 15 },
          snippet: "...search term found..."
        }
      ]
    });

    const result = await resultPromise;

    // Verify all hits are on the specified page
    const hits = (result.structuredContent as any).hits;
    expect(hits.length).toBe(1);
    expect(hits[0].pageIndex).toBe(2);
  });

  it("viewer-mcp.AC2.8: search_exact_text with zero hits returns empty array, not error", async () => {
    const { callTool } = fixture;
    const { viewUUID: sessionUUID } = sessionModule.getSession();

    const resultPromise = callTool("search_exact_text", {
      query: "nonexistent phrase xyz"
    });

    await flushMicrotasks();

    const commands = sessionModule.drain();
    expect(commands.length).toBe(1);
    const requestId = (commands[0] as any).requestId;

    // Simulate viewer response with no hits
    sessionModule.resolvePending(requestId, { hits: [] });

    const result = await resultPromise;

    // Should succeed with empty array, not throw
    expect(result.structuredContent).toEqual({
      hits: [],
      viewUUID: sessionUUID
    });

    expect((result.content[0] as any).text).toContain("No matches found");
  });

  it("viewer-mcp.AC2.6: round-trip search → set_view_state can navigate to hit", async () => {
    // Integration-style test showing data flows correctly
    const { callTool } = fixture;

    const resultPromise = callTool("search_exact_text", { query: "test" });

    await flushMicrotasks();

    const searchCommands = sessionModule.drain();
    const searchRequestId = (searchCommands[0] as any).requestId;

    const hitRect = { left: 10, top: 20, width: 100, height: 15 };
    sessionModule.resolvePending(searchRequestId, {
      hits: [
        {
          hitId: `hit-${searchRequestId}-0`,
          pageIndex: 2,
          rect: hitRect,
          snippet: "...test..."
        }
      ]
    });

    const searchResult = await resultPromise;
    const hits = (searchResult.structuredContent as any).hits;
    expect(hits.length).toBe(1);

    // Step 2: Model would use the hit to call set_view_state
    // This test demonstrates the data flows correctly
    const hit = hits[0];
    expect(hit.pageIndex).toBe(2);
    expect(hit.rect).toEqual(hitRect);

    // Verify hit data can be used in a set_view_state call
    expect(hit.rect.left).toBe(10);
    expect(hit.rect.top).toBe(20);
  });

  it("error path: viewer returns !instance (Document not open) → error result", async () => {
    const { callTool } = fixture;

    const resultPromise = callTool("search_exact_text", { query: "test" });

    await flushMicrotasks();

    const commands = sessionModule.drain();
    const requestId = (commands[0] as any).requestId;

    // Simulate viewer responding with document-not-open error
    sessionModule.resolvePending(requestId, {
      error: "Document not open"
    });

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Document not open");
  });

  it("error path: viewer returns out-of-range pageIndex → error result", async () => {
    const { callTool } = fixture;

    const resultPromise = callTool("search_exact_text", {
      query: "test",
      pageIndex: 999
    });

    await flushMicrotasks();

    const commands = sessionModule.drain();
    const requestId = (commands[0] as any).requestId;

    // Simulate viewer responding with out-of-range error
    sessionModule.resolvePending(requestId, {
      error: "pageIndex out of range: 999 (pageCount=5)"
    });

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("pageIndex out of range");
  });

  it("error path: viewer search throws and returns SDK error → error result", async () => {
    const { callTool } = fixture;

    const resultPromise = callTool("search_exact_text", { query: "test" });

    await flushMicrotasks();

    const commands = sessionModule.drain();
    const requestId = (commands[0] as any).requestId;

    // Simulate viewer catching SDK exception
    sessionModule.resolvePending(requestId, {
      error: "search failed: SDK threw: RangeError"
    });

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("search failed");
  });
});
