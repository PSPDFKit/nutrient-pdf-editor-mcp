import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { registerReadTextTool } from "../../src/mcp/tools/read-text.js";
import { assertPlainJson } from "../helpers/assertPlainJson.js";
import { flushMicrotasks } from "../helpers/mcpTestClient.js";
import { createSessionFixture, type SessionFixture } from "../helpers/sessionFixture.js";

describe("read_text", () => {
  let fixture: SessionFixture;

  beforeEach(async () => {
    fixture = await createSessionFixture([registerReadTextTool], {
      prefix: "nutrient-pdf-editor-read-text-"
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // AC-T1: No document open → standard "no open document" error
  describe("AC-T1: no document open", () => {
    it("returns McpError(InvalidParams) with the standard no-document message", async () => {
      sessionModule.clearOpenDocument();
      const { callTool } = fixture;

      const result = await callTool("read_text", {});
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("No document is currently open");
    });
  });

  // AC-T2: Full-document read fits under the cap
  describe("AC-T2: happy path — full document fits under cap", () => {
    it("returns concatenated text with page delimiters; truncated=false, nextPageStart=null, firstPage=0, lastPage=pageCount-1", async () => {
      const { callTool } = fixture;
      const { viewUUID: sessionUUID } = sessionModule.getSession();

      const resultPromise = callTool("read_text", {});

      await flushMicrotasks();

      const commands = sessionModule.drain();
      expect(commands.length).toBe(1);
      expect(commands[0]!.type).toBe("read_text");

      // Verify the command carried the right parameters
      expect((commands[0]! as any).pageStart).toBe(0);
      // pageEnd -1 signals "last page" to the viewer
      expect((commands[0]! as any).pageEnd).toBe(-1);
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        text: "\n\n=== PAGE 0 ===\n\nHello world\n\n=== PAGE 1 ===\n\nPage two text",
        pageCount: 2,
        firstPage: 0,
        lastPage: 1,
        extractedPages: 2,
        truncated: false,
        nextPageStart: null
      });

      const result = await resultPromise;

      expect(result).toHaveProperty("content");
      expect(result).toHaveProperty("structuredContent");
      expect(result).toHaveProperty("_meta");

      const sc = result.structuredContent as any;
      expect(sc.text).toContain("=== PAGE 0 ===");
      expect(sc.text).toContain("=== PAGE 1 ===");
      expect(sc.pageCount).toBe(2);
      expect(sc.firstPage).toBe(0);
      expect(sc.lastPage).toBe(1);
      expect(sc.extractedPages).toBe(2);
      expect(sc.truncated).toBe(false);
      expect(sc.nextPageStart).toBeNull();
      expect(sc.viewUUID).toBe(sessionUUID);

      expect(result._meta).toEqual({ viewUUID: sessionUUID });

      // content[0].text now carries the document text directly (plain text,
      // no JSON wrapping) — pagination metadata stays in structuredContent.
      const contentText = (result.content[0] as any).text as string;
      expect(contentText).toContain("PAGE 0");
      expect(contentText).not.toMatch(/^\s*\{/); // not a JSON blob

      // AC9.1: plain JSON in structuredContent
      assertPlainJson(sc);
    });
  });

  // AC-T3: Page range scoping + bounds errors
  describe("AC-T3: page range validation", () => {
    it("sends pageStart and pageEnd in the command when provided", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 2,
        pageEnd: 4
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      expect((commands[0]! as any).pageStart).toBe(2);
      expect((commands[0]! as any).pageEnd).toBe(4);
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        text: "\n\n=== PAGE 2 ===\n\nPage 2\n\n=== PAGE 3 ===\n\nPage 3\n\n=== PAGE 4 ===\n\nPage 4",
        pageCount: 10,
        firstPage: 2,
        lastPage: 4,
        extractedPages: 3,
        truncated: false,
        nextPageStart: null
      });

      const result = await resultPromise;
      const sc = result.structuredContent as any;
      expect(sc.firstPage).toBe(2);
      expect(sc.lastPage).toBe(4);
      expect(sc.extractedPages).toBe(3);
    });

    it("pageStart >= pageCount → error result with 'Invalid page range'", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 99,
        pageEnd: 99
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        error: "Invalid page range: pageStart=99 is out of range (pageCount=5)"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Invalid page range");
    });

    it("pageEnd >= pageCount → error result with 'Invalid page range'", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 0,
        pageEnd: 99
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        error: "Invalid page range: pageEnd=99 is out of range (pageCount=5)"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Invalid page range");
    });

    it("pageStart > pageEnd → error result with 'Invalid page range'", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 5,
        pageEnd: 2
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        error: "Invalid page range: pageStart=5 > pageEnd=2"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("Invalid page range");
    });
  });

  // AC-T4: Scanned / no-text page — empty body, no error
  describe("AC-T4: scanned / no-text page", () => {
    it("returns empty text for the page section without error", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 0,
        pageEnd: 0
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        text: "\n\n=== PAGE 0 ===\n\n",
        pageCount: 3,
        firstPage: 0,
        lastPage: 0,
        extractedPages: 1,
        truncated: false,
        nextPageStart: null
      });

      const result = await resultPromise;
      const sc = result.structuredContent as any;
      expect(sc.text).toContain("=== PAGE 0 ===");
      expect(sc.truncated).toBe(false);
    });
  });

  // AC-T5: Truncation at 100K cap — multi-call pagination round-trip
  describe("AC-T5: truncation and pagination", () => {
    it("first call returns truncated=true and nextPageStart; second call resumes and terminates", async () => {
      const { callTool } = fixture;

      // --- First call ---
      const firstResultPromise = callTool("read_text", {});

      await flushMicrotasks();
      const firstCommands = sessionModule.drain();
      expect(firstCommands[0]!.type).toBe("read_text");
      expect((firstCommands[0]! as any).pageStart).toBe(0);
      const firstRequestId = (firstCommands[0]! as any).requestId;

      // Simulate: 50 pages fit, 51st would exceed cap
      sessionModule.resolvePending(firstRequestId, {
        text: "A".repeat(99_000),
        pageCount: 100,
        firstPage: 0,
        lastPage: 49,
        extractedPages: 50,
        truncated: true,
        nextPageStart: 50
      });

      const firstResult = await firstResultPromise;
      const firstSc = firstResult.structuredContent as any;
      expect(firstSc.truncated).toBe(true);
      expect(firstSc.nextPageStart).toBe(50);
      expect(firstSc.lastPage).toBe(49);
      expect(firstSc.extractedPages).toBe(50);

      // --- Second call: resume from nextPageStart ---
      const secondResultPromise = callTool("read_text", { pageStart: 50 });

      await flushMicrotasks();
      const secondCommands = sessionModule.drain();
      expect(secondCommands[0]!.type).toBe("read_text");
      expect((secondCommands[0]! as any).pageStart).toBe(50);
      const secondRequestId = (secondCommands[0]! as any).requestId;

      sessionModule.resolvePending(secondRequestId, {
        text: "B".repeat(50_000),
        pageCount: 100,
        firstPage: 50,
        lastPage: 99,
        extractedPages: 50,
        truncated: false,
        nextPageStart: null
      });

      const secondResult = await secondResultPromise;
      const secondSc = secondResult.structuredContent as any;
      expect(secondSc.truncated).toBe(false);
      expect(secondSc.nextPageStart).toBeNull();
      expect(secondSc.firstPage).toBe(50);
      expect(secondSc.lastPage).toBe(99);
    });
  });

  // AC-T6: Single-page-exceeds-cap edge case
  describe("AC-T6: single-page-exceeds-cap edge case", () => {
    it("returns that one page anyway with extractedPages=1, truncated=true, nextPageStart=firstPage+1", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 0,
        pageEnd: 5
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      // Viewer returns single page that exceeds 100K
      sessionModule.resolvePending(requestId, {
        text: "X".repeat(105_000),
        pageCount: 10,
        firstPage: 0,
        lastPage: 0,
        extractedPages: 1,
        truncated: true,
        nextPageStart: 1
      });

      const result = await resultPromise;
      const sc = result.structuredContent as any;
      expect(sc.extractedPages).toBe(1);
      expect(sc.truncated).toBe(true);
      expect(sc.nextPageStart).toBe(1);
      expect(sc.text.length).toBeGreaterThan(100_000);
    });

    it("single-page-exceeds-cap on the last page: nextPageStart=null", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {
        pageStart: 9,
        pageEnd: 9
      });

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        text: "Y".repeat(110_000),
        pageCount: 10,
        firstPage: 9,
        lastPage: 9,
        extractedPages: 1,
        truncated: true,
        nextPageStart: null
      });

      const result = await resultPromise;
      const sc = result.structuredContent as any;
      expect(sc.extractedPages).toBe(1);
      expect(sc.truncated).toBe(true);
      expect(sc.nextPageStart).toBeNull();
    });
  });

  // AC-T7 structural checks for all ACs are covered above.
  // Additional: viewer error propagates as error result
  describe("error propagation", () => {
    it("viewer error string → error result", async () => {
      const { callTool } = fixture;

      const resultPromise = callTool("read_text", {});

      await flushMicrotasks();
      const commands = sessionModule.drain();
      const requestId = (commands[0]! as any).requestId;

      sessionModule.resolvePending(requestId, {
        error: "readText failed: SDK threw an error"
      });

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain("readText failed");
    });
  });
});
