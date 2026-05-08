import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInternalTools } from "../../src/mcp/internal-tools.js";
import {
  LICENSE_ERROR_CODE,
} from "../../src/contract/viewer-errors.js";
import {
  __resetForTesting,
  enqueue,
  getSession,
  hasPendingCommands,
  installPollWaiter,
  markViewLive,
  pruneStaleViews,
} from "../../src/mcp/session.js";
import {
  DEFAULT_RENEWAL_URL,
} from "../../src/mcp/app-resource.js";

// Fixture token that must never appear in any log output
const FIXTURE_LICENSE_KEY = "FAKE-EXPIRED-TOKEN-MUST-NOT-APPEAR-IN-OUTPUT-DEADBEEF";

// Mock the logger before importing internal-tools
vi.mock("../../src/mcp/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/mcp/logger.js")>();
  return {
    ...actual,
    log: vi.fn(),
  };
});

// Import the mocked log after the mock is set up
import { log } from "../../src/mcp/logger.js";
const mockedLog = vi.mocked(log);

// P2-20: viewer_event tool replaces sentinel-based submit_response for unsolicited
// viewer → server events. These tests exercise the new viewer_event tool handler.
describe("registerInternalTools — viewer_event tool (P2-20)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  // Type-narrowed handler reference to avoid union type issues
  type ToolHandler = (
    args: unknown,
    extra: { signal: AbortSignal; requestId: number }
  ) => Promise<unknown>;

  let viewerEventHandler: ToolHandler;

  beforeEach(() => {
    // Reset session state
    __resetForTesting();

    // Save process.env to restore after each test
    originalEnv = { ...process.env };

    // Clear the mocked log call history
    mockedLog.mockClear();

    // Initialize the viewer_event handler (index 2 in the returned tuple)
    const server = new McpServer(
      { name: "test", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    const [, , viewerEventTool] = registerInternalTools(server);
    viewerEventHandler = viewerEventTool.handler as unknown as ToolHandler;
  });

  afterEach(() => {
    // Restore process.env
    process.env = originalEnv;
  });

  describe("AC2.1: expired → error level + renewalUrl in data", () => {
    it("with configured renewal URL", async () => {
      process.env["NUTRIENT_RENEWAL_URL"] = "https://example.com/renew";

      await viewerEventHandler(
        {
          event: {
            type: "license_error",
            payload: {
              code: LICENSE_ERROR_CODE,
              subKind: "expired",
              guidance: "test guidance",
            },
          },
        },
        { signal: new AbortController().signal, requestId: 1 }
      );

      expect(mockedLog).toHaveBeenCalledWith(
        "error",
        "license.error.received",
        expect.objectContaining({
          subKind: "expired",
          renewalUrl: "https://example.com/renew",
        })
      );
    });
  });

  describe("AC2.2: invalid → warning + renewalUrl", () => {
    it("with configured renewal URL", async () => {
      process.env["NUTRIENT_RENEWAL_URL"] = "https://example.com/renew";

      await viewerEventHandler(
        {
          event: {
            type: "license_error",
            payload: {
              code: LICENSE_ERROR_CODE,
              subKind: "invalid",
              guidance: "test guidance",
            },
          },
        },
        { signal: new AbortController().signal, requestId: 1 }
      );

      expect(mockedLog).toHaveBeenCalledWith(
        "warning",
        "license.error.received",
        expect.objectContaining({
          subKind: "invalid",
          renewalUrl: "https://example.com/renew",
        })
      );
    });
  });

  describe("AC2.2: host-mismatch → warning + renewalUrl", () => {
    it("with configured renewal URL", async () => {
      process.env["NUTRIENT_RENEWAL_URL"] = "https://example.com/renew";

      await viewerEventHandler(
        {
          event: {
            type: "license_error",
            payload: {
              code: LICENSE_ERROR_CODE,
              subKind: "host-mismatch",
              guidance: "test guidance",
            },
          },
        },
        { signal: new AbortController().signal, requestId: 1 }
      );

      expect(mockedLog).toHaveBeenCalledWith(
        "warning",
        "license.error.received",
        expect.objectContaining({
          subKind: "host-mismatch",
          renewalUrl: "https://example.com/renew",
        })
      );
    });
  });

  describe("AC2.1/AC2.2: renewalUrl uses default when env unset", () => {
    it("expired uses DEFAULT_RENEWAL_URL", async () => {
      delete process.env["NUTRIENT_RENEWAL_URL"];

      await viewerEventHandler(
        {
          event: {
            type: "license_error",
            payload: {
              code: LICENSE_ERROR_CODE,
              subKind: "expired",
              guidance: "test guidance",
            },
          },
        },
        { signal: new AbortController().signal, requestId: 1 }
      );

      expect(mockedLog).toHaveBeenCalledWith(
        "error",
        "license.error.received",
        expect.objectContaining({
          subKind: "expired",
          renewalUrl: DEFAULT_RENEWAL_URL,
        })
      );
    });
  });

  describe("AC2.4: license-key never leaks in logged payload", () => {
    it("fixture token in env does not appear in log output", async () => {
      process.env["NUTRIENT_LICENSE_KEY"] = FIXTURE_LICENSE_KEY;

      await viewerEventHandler(
        {
          event: {
            type: "license_error",
            payload: {
              code: LICENSE_ERROR_CODE,
              subKind: "expired",
              guidance: "test guidance",
            },
          },
        },
        { signal: new AbortController().signal, requestId: 1 }
      );

      // Assert the license key never appears anywhere in the mocked log calls
      const logCalls = JSON.stringify(mockedLog.mock.calls);
      expect(logCalls.includes(FIXTURE_LICENSE_KEY)).toBe(false);

      // Cleanup
      delete process.env["NUTRIENT_LICENSE_KEY"];
    });
  });

  describe("viewer_error event: logs warning with message + source", () => {
    it("viewer_error logs warning with message + source, no renewalUrl", async () => {
      await viewerEventHandler(
        {
          event: {
            type: "viewer_error",
            payload: {
              message: "boom",
              source: "load",
            },
          },
        },
        { signal: new AbortController().signal, requestId: 1 }
      );

      expect(mockedLog).toHaveBeenCalledWith(
        "warning",
        "viewer.error",
        {
          message: "boom",
          source: "load",
        }
      );

      // Ensure no renewalUrl field is present
      const lastCall = mockedLog.mock.calls[mockedLog.mock.calls.length - 1];
      if (!lastCall) throw new Error("unreachable: mockedLog should have at least one call");
      expect((lastCall[2] as { renewalUrl?: unknown }).renewalUrl).toBeUndefined();
    });
  });
});

// 3A.M-7: poll_commands response shape unit test
describe("registerInternalTools — poll_commands response shape", () => {
  type PollHandler = (args: { viewUUID: string }) => Promise<{
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  }>;

  let pollHandler: PollHandler;
  let activeViewUUID: string;
  let savedLongPollEnv: string | undefined;

  beforeEach(() => {
    __resetForTesting();
    // Long-poll handler now blocks an empty queue until the timeout. Use a
    // very small timeout so the empty-result tests stay fast. This still
    // exercises the same code path the production server hits.
    savedLongPollEnv = process.env.LONG_POLL_TIMEOUT_MS;
    process.env.LONG_POLL_TIMEOUT_MS = "30";
    const server = new McpServer(
      { name: "test", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );
    const [pollTool] = registerInternalTools(server);
    pollHandler = pollTool.handler as unknown as PollHandler;
    activeViewUUID = getSession().viewUUID;
  });

  afterEach(() => {
    if (savedLongPollEnv === undefined) delete process.env.LONG_POLL_TIMEOUT_MS;
    else process.env.LONG_POLL_TIMEOUT_MS = savedLongPollEnv;
  });

  it("returns { commands: [] } when the view queue is empty (after long-poll timeout)", async () => {
    const result = await pollHandler({ viewUUID: activeViewUUID });

    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("structuredContent");

    const sc = result.structuredContent as { commands: unknown[] };
    expect(sc.commands).toEqual([]);

    // content[0].text is the JSON-stringified shape
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({ commands: [] });
  });

  it("returns enqueued commands for the matching viewUUID (fast path, no wait)", async () => {
    // Enqueue a command for the active view
    enqueue({ type: "get_view_state", requestId: "req-1" });

    const result = await pollHandler({ viewUUID: activeViewUUID });

    const sc = result.structuredContent as { commands: unknown[] };
    expect(sc.commands).toHaveLength(1);
    expect((sc.commands[0] as { type: string }).type).toBe("get_view_state");
    expect((sc.commands[0] as { requestId: string }).requestId).toBe("req-1");
  });

  it("viewUUID filter: unknown viewUUID returns empty commands after timeout", async () => {
    // Enqueue for the active view
    enqueue({ type: "get_view_state", requestId: "req-2" });

    // Poll with a different (unknown) viewUUID
    const result = await pollHandler({ viewUUID: "unknown-view-uuid-xyz" });

    const sc = result.structuredContent as { commands: unknown[] };
    expect(sc.commands).toEqual([]);
  });

  it("drain is destructive: second poll returns empty after first drains", async () => {
    enqueue({ type: "get_view_state", requestId: "req-3" });

    // First poll drains the queue (fast path)
    await pollHandler({ viewUUID: activeViewUUID });

    // Second poll waits for the long-poll timeout and returns empty
    const result = await pollHandler({ viewUUID: activeViewUUID });
    const sc = result.structuredContent as { commands: unknown[] };
    expect(sc.commands).toEqual([]);
  });

  it("wakes immediately when enqueue fires while parked", async () => {
    // Use a longer timeout so the test would obviously fail if the wake
    // doesn't fire (we'd block ~25 s rather than resolve in <50 ms).
    process.env.LONG_POLL_TIMEOUT_MS = "5000";
    const start = Date.now();
    const pollPromise = pollHandler({ viewUUID: activeViewUUID });
    setTimeout(() => {
      enqueue({ type: "get_view_state", requestId: "wake-1" });
    }, 10);
    const result = await pollPromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(200);
    const sc = result.structuredContent as { commands: unknown[] };
    expect(sc.commands).toHaveLength(1);
    expect((sc.commands[0] as { requestId: string }).requestId).toBe("wake-1");
  });

  it("second installPollWaiter for same view fires the prior waiter", () => {
    // Single in-flight invariant: a new poll for the same viewUUID must
    // resolve any prior waiter so the prior poll returns instead of leaking.
    let firedFirst = false;
    let firedSecond = false;
    const cancel1 = installPollWaiter(activeViewUUID, () => { firedFirst = true; });
    expect(firedFirst).toBe(false);

    const cancel2 = installPollWaiter(activeViewUUID, () => { firedSecond = true; });
    expect(firedFirst).toBe(true);
    expect(firedSecond).toBe(false);

    cancel1();
    cancel2();
  });

  it("pruneStaleViews wakes parked waiter and drops the queue past TTL", () => {
    // Drive the sweep by faking the clock so the heartbeat looks older than
    // VIEW_TTL_MS (60 s). markViewLive captures Date.now, which fake timers
    // override.
    vi.useFakeTimers();
    try {
      const uuid = "ttl-test-view";
      markViewLive(uuid);
      let woke = false;
      installPollWaiter(uuid, () => { woke = true; });

      vi.advanceTimersByTime(61_000);
      pruneStaleViews();

      expect(woke).toBe(true);
      expect(hasPendingCommands(uuid)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
