import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  enqueue,
  enqueueToView,
  registerPending,
  deletePending,
  type ViewerCommand
} from "./session.js";

/**
 * Read a positive-finite millisecond value from `process.env[name]` with a
 * fallback. Uses `Number.isFinite` (not `parseInt`) so `"banana"` or `"NaN"`
 * resolve to the fallback rather than producing a `NaN` that would blow up
 * `setTimeout`. See docs/environment-variables.md § "Server-side".
 */
export function readPositiveFiniteEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-round-trip timeout for viewer bridge calls (default 30 s). */
export function getViewerTimeoutMs(): number {
  return readPositiveFiniteEnvMs("VIEWER_TIMEOUT_MS", 30_000);
}

/**
 * Maximum time the server holds a `poll_commands` request open when the
 * queue is empty (default 25 s). Kept under the MCP SDK's 60 s default
 * request timeout so we resolve before the host cancels us.
 */
export function getLongPollTimeoutMs(): number {
  return readPositiveFiniteEnvMs("LONG_POLL_TIMEOUT_MS", 25_000);
}

async function executeWithTimeout<T>(
  requestId: string,
  timeoutMs: number,
  timeoutMessage: string,
  enqueueFn: () => void,
  command: ViewerCommand
): Promise<T> {
  const waiter = registerPending(requestId);
  enqueueFn();

  const signal = AbortSignal.timeout(timeoutMs);
  const timeout = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(new McpError(ErrorCode.RequestTimeout, timeoutMessage));
    });
  });

  let payload: unknown;
  try {
    payload = await Promise.race([waiter, timeout]);
  } finally {
    // Clean up the pending entry so STATE.pending doesn't leak on timeout.
    // This is a no-op when the waiter won the race (resolvePending already
    // deleted it); it removes the orphaned entry when the timeout won.
    deletePending(requestId);
  }

  return parsePayload<T>(payload, command);
}

/**
 * Bridge round-trip helper used by every operating tool except
 * `apply-annotations.ts` (which keeps its own local copy on purpose — see
 * src/mcp/AGENTS.md#Gotchas).
 *
 * Sequence:
 * 1. Register a pending entry for `requestId`.
 * 2. Enqueue the command for the viewer to pick up.
 * 3. Race the pending promise against a `timeoutMs ?? getViewerTimeoutMs()`
 *    timer. Timeout rejects with `McpError(RequestTimeout)`.
 *
 * Error contract on the rethrow path:
 * - `McpError` instances (from the timeout, the viewer's `rejectPending`,
 *   etc.) are rethrown UNCHANGED — same code, same message. The previous
 *   inline pattern wrapped `err.message` in a fresh
 *   `McpError(RequestTimeout, ...)` which silently flattened any inner
 *   code; this helper preserves the original instance instead.
 * - A viewer-submitted error payload (`{error: string}`) is converted to
 *   `McpError(InvalidParams, errorPayload.error)` per the bridge protocol's
 *   4-clause guard.
 * - Plain `Error` and unknown rejections propagate unchanged.
 */
export async function enqueueAndWait<T>(
  command: ViewerCommand,
  requestId: string,
  timeoutMs?: number
): Promise<T> {
  return executeWithTimeout<T>(
    requestId,
    timeoutMs ?? getViewerTimeoutMs(),
    `Viewer never responded to ${command.type} (requestId=${requestId})`,
    () => enqueue(command),
    command
  );
}

/**
 * Targeted variant of `enqueueAndWait` — pushes the command into a
 * SPECIFIC view's queue rather than the active view's queue. Used by the
 * close-broadcast in `open_document` so prior viewUUIDs receive their
 * `close_document` command even after the active viewUUID rolls over to
 * the new iframe.
 *
 * Same error contract as `enqueueAndWait` (timeout → McpError(RequestTimeout),
 * viewer error payload → McpError(InvalidParams), other rejections
 * propagate unchanged).
 */
export async function enqueueAndWaitForView<T>(
  viewUUID: string,
  command: ViewerCommand,
  requestId: string,
  timeoutMs?: number
): Promise<T> {
  return executeWithTimeout<T>(
    requestId,
    timeoutMs ?? getViewerTimeoutMs(),
    `Viewer ${viewUUID} never responded to ${command.type} (requestId=${requestId})`,
    () => enqueueToView(viewUUID, command),
    command
  );
}

function parsePayload<T>(payload: unknown, command: ViewerCommand): T {
  // 4-clause viewer-error guard: viewer reports failures as a plain object
  // with an `error` string per the bridge protocol.
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string"
  ) {
    throw new McpError(ErrorCode.InvalidParams, (payload as { error: string }).error);
  }
  // Touch `command` so the helper signature stays self-documenting even
  // though the value is only used inside the timeout-rejection message.
  void command;
  return payload as T;
}
