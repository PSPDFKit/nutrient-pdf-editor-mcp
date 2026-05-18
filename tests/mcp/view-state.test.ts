import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import * as sessionModule from "../../src/mcp/session.js";
import { setClientRoots, clearClientRoots } from "../../src/mcp/client-roots.js";
import { registerViewStateTools } from "../../src/mcp/tools/view-state.js";
import { randomUUID } from "node:crypto";
import { createTestClient, flushMicrotasks } from "../helpers/mcpTestClient.js";

describe("get_view_state and set_view_state", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-pdf-editor-"));
    setClientRoots([{ uri: pathToFileURL(tempDir).href }]);
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    sessionModule.setOpenDocument(path.join(tempDir, "fixture.pdf"));
  });

  afterEach(() => {
    sessionModule.clearOpenDocument();
    clearClientRoots();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  describe("get_view_state", () => {
    it("viewer-mcp.AC2.1: returns {documentPath, pageCount, activePage, viewUUID} with _meta.viewUUID", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("get_view_state", {});

      await flushMicrotasks();

      // Extract requestId from queue
      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("get_view_state");
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer response
      sessionModule.resolvePending(requestId, {
        documentPath: "/path/to/doc.pdf",
        pageCount: 5,
        activePage: 2,
        selection: undefined
      });

      const result = await resultPromise;

      // Verify structure
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("structuredContent");
      expect(result).toHaveProperty("_meta");

      // Verify structuredContent
      expect(result.structuredContent).toEqual({
        documentPath: "/path/to/doc.pdf",
        pageCount: 5,
        activePage: 2,
        viewUUID: sessionUUID
      });

      // Verify _meta.viewUUID
      expect(result._meta).toEqual({ viewUUID: sessionUUID });

      // Verify content is valid JSON
      const contentText = (result.content[0] as any).text;
      const parsed = JSON.parse(contentText);
      expect(parsed).toEqual({
        documentPath: "/path/to/doc.pdf",
        pageCount: 5,
        activePage: 2,
        viewUUID: sessionUUID
      });
    });
  });

  describe("set_view_state", () => {
    it("viewer-mcp.AC2.1: empty input {}, no activePage/scrollTo/selection, returns error", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      // Call with empty input — tool handler throws McpError → isError result
      const result = await callTool("set_view_state", {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("at least one of");

      // Verify nothing was enqueued (no pending request)
      const commands = sessionModule.drain();
      expect(commands.length).toBe(0);
    });

    it("viewer-mcp.AC2.2: sets activePage and returns updated state", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("set_view_state", { activePage: 3 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("set_view_state");
      expect((commands[0]! as any).activePage).toBe(3);
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer response
      sessionModule.resolvePending(requestId, {
        documentPath: "/path/to/doc.pdf",
        pageCount: 5,
        activePage: 3,
        selection: undefined
      });

      const result = await resultPromise;

      expect(result.structuredContent).toEqual({
        documentPath: "/path/to/doc.pdf",
        pageCount: 5,
        activePage: 3,
        viewUUID: sessionUUID
      });
    });

    it("viewer-mcp.AC2.3: sets scrollTo with pageIndex and rect", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const scrollTo = {
        pageIndex: 2,
        rect: { left: 10, top: 20, width: 100, height: 50 }
      };

      const resultPromise = callTool("set_view_state", { scrollTo });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("set_view_state");
      expect((commands[0]! as any).scrollTo).toEqual(scrollTo);
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer response
      sessionModule.resolvePending(requestId, {
        documentPath: "/path/to/doc.pdf",
        pageCount: 5,
        activePage: 2,
        selection: undefined
      });

      const result = await resultPromise;
      expect((result.structuredContent as any).activePage).toBe(2);
    });

    it("viewer-mcp.AC2.7: out-of-range activePage returns error", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const resultPromise = callTool("set_view_state", { activePage: -1 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      const requestId = (commands[0]! as any).requestId;

      // Viewer rejects with error
      sessionModule.resolvePending(requestId, {
        error: "Invalid activePage: -1, valid range is 0-4"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Invalid activePage");
    });

    it("viewer-mcp.AC2.7: out-of-range scrollTo.pageIndex returns error", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const scrollTo = {
        pageIndex: 999,
        rect: { left: 10, top: 20, width: 100, height: 50 }
      };

      const resultPromise = callTool("set_view_state", { scrollTo });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      const requestId = (commands[0]! as any).requestId;

      // Viewer rejects with error
      sessionModule.resolvePending(requestId, {
        error: "Invalid scrollTo.pageIndex: 999, valid range is 0-4"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Invalid scrollTo.pageIndex");
    });

    it("error path: get_view_state with !instance → error result", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const resultPromise = callTool("get_view_state", {});

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

    it("error path: set_view_state with !instance → error result", async () => {
      const { callTool } = await createTestClient([registerViewStateTools]);

      const resultPromise = callTool("set_view_state", { activePage: 2 });

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
  });
});
