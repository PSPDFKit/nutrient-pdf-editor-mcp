import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import * as sessionModule from "../../src/mcp/session.js";
import { setClientRoots, clearClientRoots } from "../../src/mcp/client-roots.js";
import { registerOpenDocument } from "../../src/mcp/tools/open-document.js";
import { randomUUID } from "node:crypto";
import { createTestClient, flushMicrotasks } from "../helpers/mcpTestClient.js";

describe("open_document", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-pdf-editor-"));
    setClientRoots([{ uri: pathToFileURL(tempDir).href }]);
    sessionModule.__resetForTesting();
    sessionModule.setActiveViewUUID(randomUUID());
  });

  afterEach(() => {
    clearClientRoots();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch { /* ignore */ }
  });

  it("returns {documentPath, viewUUID} immediately with ui.resourceUri in _meta", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const testFile = path.join(tempDir, "test.pdf");
    fs.writeFileSync(testFile, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const priorViewUUID = sessionModule.getSession().viewUUID;
    const result = await callTool("open_document", { path: testFile });

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("structuredContent");
    expect(result).toHaveProperty("_meta");

    // open_document now generates a FRESH viewUUID per call (the
    // close-broadcast in option (C) needs each open to mint a new viewUUID
    // so the new iframe is distinguishable from prior iframes the
    // broadcast targets).
    const sc = result.structuredContent as any;
    const newViewUUID = sc.viewUUID;
    expect(typeof newViewUUID).toBe("string");
    expect(newViewUUID).not.toBe(priorViewUUID);
    // Session's active viewUUID is updated to match.
    expect(sessionModule.getSession().viewUUID).toBe(newViewUUID);

    expect(sc).toEqual({
      documentPath: testFile,
      viewUUID: newViewUUID
    });

    expect((result._meta as any).viewUUID).toBe(newViewUUID);
    expect(((result._meta as any).ui as { resourceUri: string }).resourceUri).toBe(
      "ui://nutrient-viewer/mcp-app.html"
    );

    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed).toEqual({ documentPath: testFile, viewUUID: newViewUUID });
  });

  it("does not enqueue a viewer command — iframe loads via ontoolresult", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const testFile = path.join(tempDir, "test.pdf");
    fs.writeFileSync(testFile, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await callTool("open_document", { path: testFile });

    // Idiomatic MCP Apps flow: no command sits in the queue; the iframe picks
    // up the documentPath from structuredContent and loads directly.
    expect(sessionModule.drain()).toEqual([]);
  });

  it("consecutive operations return the same session viewUUID", async () => {
    const state1 = sessionModule.getSession();
    const uuid1 = state1.viewUUID;

    // Creating the client registers the tool but doesn't change session state
    await createTestClient([registerOpenDocument]);

    const state2 = sessionModule.getSession();
    expect(uuid1).toBe(state2.viewUUID);
  });

  it("path outside allowed roots rejects with error result", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const result = await callTool("open_document", { path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("Path outside MCP-advertised roots");
  });

  it("missing file rejects with error result", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const missing = path.join(tempDir, "does-not-exist.pdf");
    const result = await callTool("open_document", { path: missing });
    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("File not found");
  });

  it("AC4.1: records the opened document path in session state", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const testFile = path.join(tempDir, "test.pdf");
    fs.writeFileSync(testFile, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await callTool("open_document", { path: testFile });

    const state = sessionModule.getSession();
    expect(state.documentPath).toBe(testFile);
  });

  it("re-open clears stale fs-sync flags from the prior path (no leak across in-place swap)", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const file1 = path.join(tempDir, "a.pdf");
    const file2 = path.join(tempDir, "b.pdf");
    fs.writeFileSync(file1, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    fs.writeFileSync(file2, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    await callTool("open_document", { path: file1 });
    // Simulate the staleness watcher having flipped dirty for file1, plus a
    // save bracket left set after the watcher self-suppression debounce.
    sessionModule.setDocumentDirty(true);
    sessionModule.setIsPendingSave(true);

    await callTool("open_document", { path: file2 });

    expect(sessionModule.isDocumentDirty()).toBe(false);
    expect(sessionModule.isPendingSave()).toBe(false);
    // startWatching populates a fresh checkpoint for file2.
    const cp = sessionModule.getDocumentCheckpoint();
    expect(cp).not.toBeNull();
    expect(cp!.size).toBe(fs.statSync(file2).size);
  });

  it("re-open with a different path updates state without enqueueing a close (in-place SDK swap is iframe-side)", async () => {
    const { callTool } = await createTestClient([registerOpenDocument]);

    const file1 = path.join(tempDir, "test1.pdf");
    const file2 = path.join(tempDir, "test2.pdf");
    fs.writeFileSync(file1, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    fs.writeFileSync(file2, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    // First open
    const result1 = await callTool("open_document", { path: file1 });
    expect((result1.structuredContent as any).documentPath).toBe(file1);
    expect((result1.structuredContent as any).notice).toBeUndefined();

    // open_document never enqueues viewer commands.
    expect(sessionModule.drain().length).toBe(0);

    // Second open — the iframe handles the unload+load atomic swap; the server
    // does NOT enqueue a close_document. No notice is produced.
    const result2 = await callTool("open_document", { path: file2 });
    expect((result2.structuredContent as any).documentPath).toBe(file2);
    expect((result2.structuredContent as any).notice).toBeUndefined();
    expect(sessionModule.drain().length).toBe(0);

    // Final server-side state reflects the second document.
    expect(sessionModule.getSession().documentPath).toBe(file2);
  });

  describe("broadcast-close to prior live viewUUIDs", () => {
    it("enqueues close_document for each live prior viewUUID and waits for ack", async () => {
      const { callTool } = await createTestClient([registerOpenDocument]);

      const file1 = path.join(tempDir, "first.pdf");
      const file2 = path.join(tempDir, "second.pdf");
      fs.writeFileSync(file1, Buffer.from([0x25, 0x50, 0x44, 0x46]));
      fs.writeFileSync(file2, Buffer.from([0x25, 0x50, 0x44, 0x46]));

      // First open mints viewUUID_A; mark it live so it's a broadcast target.
      const r1 = await callTool("open_document", { path: file1 });
      const viewA: string = (r1.structuredContent as any).viewUUID;
      sessionModule.markViewLive(viewA);

      // Second open should broadcast `close_document` to viewA.
      const handlerPromise = callTool("open_document", { path: file2 });

      // Wait one tick for the broadcast to enqueue into viewA's queue.
      await new Promise((r) => setTimeout(r, 10));
      const closeQueued = sessionModule.drainView(viewA);
      expect(closeQueued).toHaveLength(1);
      expect(closeQueued[0]).toMatchObject({ type: "close_document" });
      const requestId = closeQueued[0]!.requestId;

      // Simulate viewA's iframe acking the close.
      sessionModule.resolvePending(requestId, { closed: true });

      // open_document completes only after the broadcast settles.
      const r2 = await handlerPromise;
      const viewB: string = (r2.structuredContent as any).viewUUID;
      expect(viewB).not.toBe(viewA);
      expect(sessionModule.getSession().viewUUID).toBe(viewB);
      // viewB itself was never enqueued anything.
      expect(sessionModule.drainView(viewB)).toEqual([]);
    });

    it("proceeds even if a prior view never acks (broadcast timeout is bounded)", async () => {
      const { callTool } = await createTestClient([registerOpenDocument]);

      const file1 = path.join(tempDir, "first.pdf");
      const file2 = path.join(tempDir, "second.pdf");
      fs.writeFileSync(file1, Buffer.from([0x25, 0x50, 0x44, 0x46]));
      fs.writeFileSync(file2, Buffer.from([0x25, 0x50, 0x44, 0x46]));

      const r1 = await callTool("open_document", { path: file1 });
      sessionModule.markViewLive((r1.structuredContent as any).viewUUID);

      // Shrink the broadcast timeout via env override so this test isn't a
      // multi-second slog. Without the override the broadcast would wait
      // 2 s for the never-coming ack.
      const oldEnv = process.env.CLOSE_BROADCAST_TIMEOUT_MS;
      process.env.CLOSE_BROADCAST_TIMEOUT_MS = "100";

      try {
        const start = Date.now();
        const r2 = await callTool("open_document", { path: file2 });
        const elapsed = Date.now() - start;
        // Should be ≈ broadcast timeout. Allow headroom for slow CI.
        expect(elapsed).toBeLessThan(1000);
        expect(elapsed).toBeGreaterThanOrEqual(80);
        // open_document still rolled the active viewUUID and set the new path.
        expect((r2.structuredContent as any).documentPath).toBe(file2);
        expect(sessionModule.getSession().documentPath).toBe(file2);
      } finally {
        if (oldEnv !== undefined) process.env.CLOSE_BROADCAST_TIMEOUT_MS = oldEnv;
        else delete process.env.CLOSE_BROADCAST_TIMEOUT_MS;
      }
    });

    it("skips dead views (views that haven't polled within the staleness window)", async () => {
      const { callTool } = await createTestClient([registerOpenDocument]);

      const file1 = path.join(tempDir, "first.pdf");
      const file2 = path.join(tempDir, "second.pdf");
      fs.writeFileSync(file1, Buffer.from([0x25, 0x50, 0x44, 0x46]));
      fs.writeFileSync(file2, Buffer.from([0x25, 0x50, 0x44, 0x46]));

      const r1 = await callTool("open_document", { path: file1 });
      const viewA: string = (r1.structuredContent as any).viewUUID;
      // Do NOT mark viewA as polled — it's "dead" from the broadcast's
      // perspective. The second open should skip it (no enqueue, no wait).

      const start = Date.now();
      const r2 = await callTool("open_document", { path: file2 });
      const elapsed = Date.now() - start;
      // No broadcast happened, so the second open returns near-immediately.
      expect(elapsed).toBeLessThan(500);
      expect((r2.structuredContent as any).viewUUID).not.toBe(viewA);
      // viewA's queue was never written to.
      expect(sessionModule.drainView(viewA)).toEqual([]);
    });

    it("does not broadcast when no prior view is live (first-ever open)", async () => {
      const { callTool } = await createTestClient([registerOpenDocument]);

      const file = path.join(tempDir, "first.pdf");
      fs.writeFileSync(file, Buffer.from([0x25, 0x50, 0x44, 0x46]));

      const start = Date.now();
      const r = await callTool("open_document", { path: file });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);
      expect((r.structuredContent as any).documentPath).toBe(file);
    });
  });
});
