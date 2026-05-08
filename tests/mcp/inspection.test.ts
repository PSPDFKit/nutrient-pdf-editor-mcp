import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import * as sessionModule from "../../src/mcp/session.js";
import { setClientRoots, clearClientRoots } from "../../src/mcp/client-roots.js";
import { registerDocumentInformationTool } from "../../src/mcp/tools/read-document-information.js";
import { registerPageInfoTool } from "../../src/mcp/tools/read-page-info.js";
import { registerPageImageTool } from "../../src/mcp/tools/get-page-image.js";
import { randomUUID } from "node:crypto";
import { assertPlainJson } from "../helpers/assertPlainJson.js";
import { createTestClient, flushMicrotasks } from "../helpers/mcpTestClient.js";

describe("Document and page inspection tools", () => {
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

  describe("read_document_information", () => {
    it("viewer-mcp.AC6.1: returns {pageCount, title?, permissions} with viewUUID in _meta", async () => {
      const { callTool } = await createTestClient([registerDocumentInformationTool]);

      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("read_document_information", {});

      await flushMicrotasks();

      // Extract requestId from queue
      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_document_information");
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer response
      sessionModule.resolvePending(requestId, {
        pageCount: 10,
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
      });

      const result = await resultPromise;

      // Verify structure
      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("structuredContent");
      expect(result).toHaveProperty("_meta");

      // Verify structuredContent shape
      expect(result.structuredContent).toEqual({
        pageCount: 10,
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
        },
        viewUUID: sessionUUID
      });

      // AC9.1: Verify response is plain JSON
      assertPlainJson(result.structuredContent);

      // Verify _meta.viewUUID
      expect(result._meta).toEqual({ viewUUID: sessionUUID });

      // content[0].text is markdown — assert key user-readable signals only.
      const contentText = (result.content[0] as any).text;
      expect(contentText).toContain("# Document Information");
      expect(contentText).toContain("Sample Document");
      expect(contentText).toContain("**Pages:** 10");
    });

    it("viewer-mcp.AC6.1: handles missing title gracefully", async () => {
      const { callTool } = await createTestClient([registerDocumentInformationTool]);

      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("read_document_information", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0] as any).requestId;

      // Simulate viewer response with no title
      sessionModule.resolvePending(requestId, {
        pageCount: 5,
        permissions: {
          annotationsAndForms: false,
          assemble: false,
          extract: true,
          extractAccessibility: true,
          fillForms: false,
          modification: false,
          printHighQuality: false,
          printing: false
        }
      });

      const result = await resultPromise;

      expect(result.structuredContent).toEqual({
        pageCount: 5,
        permissions: {
          annotationsAndForms: false,
          assemble: false,
          extract: true,
          extractAccessibility: true,
          fillForms: false,
          modification: false,
          printHighQuality: false,
          printing: false
        },
        viewUUID: sessionUUID
      });
      // title should not be in structuredContent if not provided
      expect(result.structuredContent).not.toHaveProperty("title");
    });
  });

  describe("read_page_info", () => {
    it("viewer-mcp.AC6.2: returns {width, height, rotation} in points for valid page", async () => {
      const { callTool } = await createTestClient([registerPageInfoTool]);

      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("read_page_info", { pageIndex: 0 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_page_info");
      expect((commands[0]! as any).pageIndex).toBe(0);
      const requestId = (commands[0]! as any).requestId;

      // Simulate viewer response
      sessionModule.resolvePending(requestId, {
        width: 612,
        height: 792,
        rotation: 0
      });

      const result = await resultPromise;

      expect(result.structuredContent).toEqual({
        width: 612,
        height: 792,
        rotation: 0,
        viewUUID: sessionUUID
      });

      expect(result._meta).toEqual({ viewUUID: sessionUUID });
    });

    it("viewer-mcp.AC6.2: handles different rotations", async () => {
      const { callTool } = await createTestClient([registerPageInfoTool]);

      const resultPromise = callTool("read_page_info", { pageIndex: 2 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0] as any).requestId;

      // Simulate rotated page
      sessionModule.resolvePending(requestId, {
        width: 792,
        height: 612,
        rotation: 90
      });

      const result = await resultPromise;

      expect(result.structuredContent).toEqual({
        width: 792,
        height: 612,
        rotation: 90,
        viewUUID: sessionModule.getSession().viewUUID
      });
    });

    it("viewer-mcp.AC6.2: out-of-range pageIndex returns error", async () => {
      const { callTool } = await createTestClient([registerPageInfoTool]);

      const resultPromise = callTool("read_page_info", { pageIndex: 999 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0] as any).requestId;

      // Viewer returns structured error
      sessionModule.resolvePending(requestId, {
        error: "Page index 999 out of range"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Page index");
    });
  });

  describe("get_page_image", () => {
    it("viewer-mcp.AC6.3: returns image content block with bare base64 payload", async () => {
      const { callTool } = await createTestClient([registerPageImageTool]);

      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("get_page_image", { pageIndex: 0 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("get_page_image");
      expect((commands[0]! as any).pageIndex).toBe(0);
      expect((commands[0]! as any).width).toBe(1200); // default width
      const requestId = (commands[0]! as any).requestId;

      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      sessionModule.resolvePending(requestId, {
        pngDataUrl: `data:image/png;base64,${base64}`,
        pageWidth: 612,
        pageHeight: 792,
        renderedWidth: 1200
      });

      const result = await resultPromise;

      expect(result.structuredContent).toEqual({
        pageWidth: 612,
        pageHeight: 792,
        renderedWidth: 1200,
        viewUUID: sessionUUID
      });
      expect(result.structuredContent).not.toHaveProperty("pngDataUrl");

      expect(result._meta).toEqual({ viewUUID: sessionUUID });

      expect(result.content[0]).toEqual({
        type: "image",
        data: base64,
        mimeType: "image/png"
      });
      expect((result.content[1] as any).type).toBe("text");
      expect((result.content[1] as any).text).toContain("Page 0 dimensions");
      expect((result.content[1] as any).text).toContain("Scale factor:");
    });

    it("viewer-mcp.AC6.3: respects custom width parameter", async () => {
      const { callTool } = await createTestClient([registerPageImageTool]);

      const resultPromise = callTool("get_page_image", { pageIndex: 0, width: 800 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect((commands[0] as any).width).toBe(800);
      const requestId = (commands[0] as any).requestId;

      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      sessionModule.resolvePending(requestId, {
        pngDataUrl: `data:image/png;base64,${base64}`
      });

      const result = await resultPromise;
      expect(result.content[0]).toEqual({
        type: "image",
        data: base64,
        mimeType: "image/png"
      });
    });

    it("viewer-mcp.AC6.4: out-of-range pageIndex returns error", async () => {
      const { callTool } = await createTestClient([registerPageImageTool]);

      const resultPromise = callTool("get_page_image", { pageIndex: 999 });

      await flushMicrotasks();

      const commands = sessionModule.drain();
      const requestId = (commands[0] as any).requestId;

      // Viewer returns structured error
      sessionModule.resolvePending(requestId, {
        error: "Page index 999 out of range"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Page index");
    });

    it("error path: read_document_information with !instance → error result", async () => {
      const { callTool } = await createTestClient([registerDocumentInformationTool]);

      const resultPromise = callTool("read_document_information", {});

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

    it("error path: read_page_info with !instance → error result", async () => {
      const { callTool } = await createTestClient([registerPageInfoTool]);

      const resultPromise = callTool("read_page_info", { pageIndex: 0 });

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

    it("error path: get_page_image with !instance → error result", async () => {
      const { callTool } = await createTestClient([registerPageImageTool]);

      const resultPromise = callTool("get_page_image", { pageIndex: 0 });

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
