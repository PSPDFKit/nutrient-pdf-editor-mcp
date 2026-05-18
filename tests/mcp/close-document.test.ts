import { describe, it, expect, beforeEach } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { registerCloseDocumentTool } from "../../src/mcp/tools/close-document.js";
import { randomUUID } from "node:crypto";
import { createTestClient, flushMicrotasks } from "../helpers/mcpTestClient.js";

describe("close_document", () => {
  beforeEach(() => {
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    state.documentPath = null;
  });

  it("AC7.1: enqueues close_document command and returns {closed: true} after iframe ack", async () => {
    const { callTool } = await createTestClient([registerCloseDocumentTool]);

    // Set up a document in the session
    sessionModule.setOpenDocument("/tmp/test.pdf");

    // Call the tool (this will enqueue and wait)
    const resultPromise = callTool("close_document", {});

    // Wait for the enqueue to complete
    await flushMicrotasks();

    // Verify the command was enqueued
    const commands = sessionModule.drain();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "close_document" });
    const requestId = commands[0]!.requestId;

    // Simulate iframe ack by resolving the pending promise
    sessionModule.resolvePending(requestId, { closed: true });

    // Wait for the tool to complete
    const result = await resultPromise;

    // Verify the result
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("structuredContent");
    expect(result).toHaveProperty("_meta");
    expect(result.structuredContent).toEqual({ closed: true });
    expect((result._meta as any).viewUUID).toBe(sessionModule.getSession().viewUUID);
  });

  it("clears session documentPath after a successful close", async () => {
    const { callTool } = await createTestClient([registerCloseDocumentTool]);

    sessionModule.setOpenDocument("/tmp/test.pdf");
    expect(sessionModule.getSession().documentPath).toBe("/tmp/test.pdf");

    const resultPromise = callTool("close_document", {});
    await flushMicrotasks();

    const commands = sessionModule.drain();
    const requestId = commands[0]!.requestId;

    sessionModule.resolvePending(requestId, { closed: true });
    await resultPromise;

    expect(sessionModule.getSession().documentPath).toBe(null);
  });

  it("handles best-effort ack timeout by clearing state anyway", async () => {
    const { callTool } = await createTestClient([registerCloseDocumentTool]);

    sessionModule.setOpenDocument("/tmp/test.pdf");

    // Set a very short timeout
    const oldEnv = process.env.VIEWER_TIMEOUT_MS;
    process.env.VIEWER_TIMEOUT_MS = "50";

    try {
      // Don't resolve the pending promise - let it timeout
      const resultPromise = callTool("close_document", {});

      // Handler should still succeed despite timeout
      const result = await resultPromise;

      // Verify the handler completed successfully
      expect(result).toHaveProperty("structuredContent");
      expect(result.structuredContent).toEqual({ closed: true });

      // Verify state was still cleared
      expect(sessionModule.getSession().documentPath).toBe(null);
    } finally {
      if (oldEnv !== undefined) {
        process.env.VIEWER_TIMEOUT_MS = oldEnv;
      } else {
        delete process.env.VIEWER_TIMEOUT_MS;
      }
    }
  });

  it("is an idempotent no-op when no document is open", async () => {
    const { callTool } = await createTestClient([registerCloseDocumentTool]);

    // No document is open at this point.
    expect(sessionModule.hasOpenDocument()).toBe(false);

    const result = await callTool("close_document", {});
    expect(result.structuredContent).toEqual({ closed: true });
    expect((result._meta as any).viewUUID).toBe(sessionModule.getSession().viewUUID);

    // Nothing was enqueued (no command sent to the iframe).
    expect(sessionModule.drain()).toEqual([]);
  });
});
