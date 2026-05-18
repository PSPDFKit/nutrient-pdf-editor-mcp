import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as sessionModule from "../../src/mcp/session.js";
import { enqueueAndWait, getViewerTimeoutMs } from "../../src/mcp/bridge.js";
import { randomUUID } from "node:crypto";
import type { ViewerCommand } from "../../src/mcp/session.js";

describe("bridge — getViewerTimeoutMs", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.VIEWER_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VIEWER_TIMEOUT_MS;
    } else {
      process.env.VIEWER_TIMEOUT_MS = originalEnv;
    }
  });

  it("returns the default 30000 when the env var is unset", () => {
    delete process.env.VIEWER_TIMEOUT_MS;
    expect(getViewerTimeoutMs()).toBe(30000);
  });

  it("parses a positive numeric env value", () => {
    process.env.VIEWER_TIMEOUT_MS = "1500";
    expect(getViewerTimeoutMs()).toBe(1500);
  });

  it("falls back to 30000 when env var is non-numeric (Number.isFinite guard)", () => {
    // The CR-004 motivation: parseInt("banana") === NaN would silently
    // propagate; the helper's Number.isFinite guard blocks it.
    process.env.VIEWER_TIMEOUT_MS = "banana";
    expect(getViewerTimeoutMs()).toBe(30000);
  });

  it("falls back to 30000 on zero / negative / NaN inputs", () => {
    process.env.VIEWER_TIMEOUT_MS = "0";
    expect(getViewerTimeoutMs()).toBe(30000);
    process.env.VIEWER_TIMEOUT_MS = "-100";
    expect(getViewerTimeoutMs()).toBe(30000);
    process.env.VIEWER_TIMEOUT_MS = "NaN";
    expect(getViewerTimeoutMs()).toBe(30000);
  });
});

describe("bridge — enqueueAndWait", () => {
  beforeEach(() => {
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    state.documentPath = null;
  });

  function mkCmd(requestId: string): ViewerCommand {
    return { type: "get_view_state", requestId };
  }

  it("happy path: resolves with the value the viewer submits", async () => {
    const requestId = randomUUID();
    const promise = enqueueAndWait<{ activePage: number }>(mkCmd(requestId), requestId);

    // Wait a tick so the helper has registered + enqueued.
    await new Promise((r) => setTimeout(r, 0));
    const queued = sessionModule.drain();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.requestId).toBe(requestId);

    sessionModule.resolvePending(requestId, { activePage: 7 });

    await expect(promise).resolves.toEqual({ activePage: 7 });
  });

  it("viewer-error payload: { error: 'msg' } becomes McpError(InvalidParams, 'msg')", async () => {
    const requestId = randomUUID();
    const promise = enqueueAndWait(mkCmd(requestId), requestId);
    const settled = promise.catch((e) => e);

    await new Promise((r) => setTimeout(r, 0));
    sessionModule.drain();

    sessionModule.resolvePending(requestId, { error: "Document not open" });

    const err = await settled;
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((err as McpError).message).toContain("Document not open");
  });

  it("McpError pass-through: viewer rejection with an existing McpError is rethrown unchanged", async () => {
    // CR-005 lock-in: when the bridge primitive rejects with an `McpError`,
    // the helper must re-throw the SAME instance — not wrap it. Inline tools
    // historically wrapped `err.message` and silently flattened the inner
    // code; this assertion keeps the helper honest.
    const requestId = randomUUID();
    const promise = enqueueAndWait(mkCmd(requestId), requestId);
    const settled = promise.catch((e) => e);

    await new Promise((r) => setTimeout(r, 0));
    sessionModule.drain();

    const original = new McpError(ErrorCode.MethodNotFound, "no such tool");
    sessionModule.rejectPending(requestId, original);

    const err = await settled;
    expect(err).toBe(original); // same instance
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    expect((err as McpError).message).toContain("no such tool");
  });

  it("plain Error from the viewer is propagated unchanged", async () => {
    // Existing internal-tools.ts path: viewer-side errors come through as
    // `new Error(error)` via `submit_response`'s `error` field. The helper
    // must NOT wrap these in an McpError (CR-005 inconsistency the refactor
    // closes — inline tools used to convert these to McpError(RequestTimeout),
    // which silently mislabeled the error code).
    const requestId = randomUUID();
    const promise = enqueueAndWait(mkCmd(requestId), requestId);
    const settled = promise.catch((e) => e);

    await new Promise((r) => setTimeout(r, 0));
    sessionModule.drain();

    const original = new Error("submit-side failure");
    sessionModule.rejectPending(requestId, original);

    const err = await settled;
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(McpError);
  });

  // 4A.M8: fake-timer tests in a consistent beforeEach/afterEach block
  describe("fake-timer tests (timeout behaviour)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("timeout path: rejects with McpError(RequestTimeout) when viewer never responds", async () => {
      const requestId = randomUUID();
      const promise = enqueueAndWait(mkCmd(requestId), requestId, 1000);
      // Catch the rejection up-front so the rejection isn't reported as
      // unhandled before the assertion settles.
      const settled = promise.catch((e) => e);

      // Drain the synchronously-enqueued command.
      await Promise.resolve();
      sessionModule.drain();

      vi.advanceTimersByTime(1500);
      const err = await settled;
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.RequestTimeout);
      expect((err as McpError).message).toContain(requestId);
      expect((err as McpError).message).toContain("get_view_state");
    });

    // P2-22 + P3-12: pending-map must not leak on timeout
    it("pending-map is empty after timeout fires (no STATE.pending leak)", async () => {
      const requestId = randomUUID();
      const promise = enqueueAndWait(mkCmd(requestId), requestId, 500);
      const settled = promise.catch((e) => e);

      await Promise.resolve();
      sessionModule.drain();

      // Before timeout: entry exists
      expect(sessionModule.getSession().pending.has(requestId)).toBe(true);

      vi.advanceTimersByTime(600);
      await settled;

      // After timeout: entry must be cleaned up
      expect(sessionModule.getSession().pending.size).toBe(0);
    });

    it("uses getViewerTimeoutMs() when timeoutMs is not supplied", async () => {
      const oldEnv = process.env.VIEWER_TIMEOUT_MS;
      process.env.VIEWER_TIMEOUT_MS = "2000";
      try {
        const requestId = randomUUID();
        const promise = enqueueAndWait(mkCmd(requestId), requestId);
        const settled = promise.catch((e) => e);

        await Promise.resolve();
        sessionModule.drain();

        // 1999 ms — should still be pending
        vi.advanceTimersByTime(1999);
        // No way to assert "still pending" reliably with fake timers; advance
        // past the env-var threshold and check the rejection lands.
        vi.advanceTimersByTime(2);

        const err = await settled;
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(ErrorCode.RequestTimeout);
      } finally {
        if (oldEnv === undefined) {
          delete process.env.VIEWER_TIMEOUT_MS;
        } else {
          process.env.VIEWER_TIMEOUT_MS = oldEnv;
        }
      }
    });
  });
});

// P2-23: submit_response first-response-wins idempotency
describe("bridge — submit_response idempotency (resolvePending)", () => {
  beforeEach(() => {
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    state.documentPath = null;
  });

  it("duplicate requestId is a no-op: second resolve doesn't throw or mutate", async () => {
    const requestId = randomUUID();

    // Register a pending entry and resolve it immediately.
    const promise = sessionModule.registerPending(requestId);
    sessionModule.resolvePending(requestId, { activePage: 1 });

    // The entry is now gone from STATE.pending.
    expect(sessionModule.getSession().pending.has(requestId)).toBe(false);

    // A second resolve for the same requestId must not throw and must not
    // re-add the requestId to STATE.pending.
    expect(() => {
      sessionModule.resolvePending(requestId, { activePage: 99 });
    }).not.toThrow();

    expect(sessionModule.getSession().pending.has(requestId)).toBe(false);

    // The original promise settled with the first value, not the duplicate.
    await expect(promise).resolves.toEqual({ activePage: 1 });
  });

  it("duplicate rejectPending is also a no-op", async () => {
    const requestId = randomUUID();

    const promise = sessionModule.registerPending(requestId);
    sessionModule.resolvePending(requestId, { ok: true });

    // Second call — should silently no-op.
    expect(() => {
      sessionModule.rejectPending(requestId, new Error("stale rejection"));
    }).not.toThrow();

    // Promise settled with the original value.
    await expect(promise).resolves.toEqual({ ok: true });
    expect(sessionModule.getSession().pending.size).toBe(0);
  });
});
