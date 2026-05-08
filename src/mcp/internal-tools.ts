import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  drainView,
  hasPendingCommands,
  installPollWaiter,
  markViewLive,
  rejectPending,
  resolvePending,
  setLicenseError
} from "./session.js";
import { getLongPollTimeoutMs } from "./bridge.js";
import { POLL_INTERVAL_MS } from "./shared-state/file-backend.js";
import { LICENSE_ERROR_CODE, type LicenseErrorPayload } from "../contract/viewer-errors.js";
import { type LogLevel, log } from "./logger.js";
import { getRenewalUrl } from "./app-resource.js";

/**
 * Typed viewer-event union. Viewer pushes one of these when it needs
 * to report an unsolicited state change (license error at load time, generic
 * SDK error after an already-resolved tool call). Using a dedicated tool with
 * a discriminated `type` field avoids the sentinel requestId strings that
 * `submit_response` previously overloaded.
 */
const viewerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("license_error"),
    payload: z.object({
      code: z.string(),
      subKind: z.enum(["invalid", "expired", "host-mismatch"]),
      guidance: z.string()
    })
  }),
  z.object({
    type: z.literal("viewer_error"),
    payload: z.object({
      message: z.string(),
      // Mirrors ViewerErrorPayload.source — currently only "load" is used
      // but kept as a z.string() so future additions don't require a schema bump.
      source: z.string().optional()
    })
  })
]);

type ViewerEvent = z.infer<typeof viewerEventSchema>;

const sharedStateActive = (): boolean => process.env.NUTRIENT_SHARED_STATE === "1";

/**
 * Park a `poll_commands` request until an enqueue arrives or the timeout
 * elapses. Three signal channels race:
 *   - In-process waiter (single-process backend wakes instantly).
 *   - `POLL_INTERVAL_MS` tick on `hasPendingCommands` (shared-state path,
 *     where the producer is in another process). Skipped on single-process
 *     since the in-process waiter covers it and each tick reads + parses
 *     the shared state file.
 *   - Overall `timeoutMs` so an idle queue still returns to the viewer.
 *
 * The `done` flag stops the tick loop when any signal wins so its inner
 * `setTimeout` doesn't keep firing for the rest of the window.
 */
async function waitForEnqueueOrTimeout(viewUUID: string, timeoutMs: number): Promise<void> {
  // Default to a no-op so TS doesn't narrow `cancelWaiter` to `null` — the
  // Promise constructor's executor runs synchronously and always overwrites
  // it, but TS doesn't see that across the closure.
  let cancelWaiter: () => void = () => {};
  let done = false;
  const wakePromise = new Promise<void>((resolve) => {
    cancelWaiter = installPollWaiter(viewUUID, resolve);
  });
  const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  const racers: Promise<void>[] = [wakePromise, timeoutPromise];
  if (sharedStateActive()) {
    racers.push(
      (async () => {
        const start = Date.now();
        while (!done && Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          if (done) return;
          if (hasPendingCommands(viewUUID)) return;
        }
      })()
    );
  }
  try {
    await Promise.race(racers);
  } finally {
    done = true;
    cancelWaiter();
  }
}

export function registerInternalTools(
  server: McpServer
): [RegisteredTool, RegisteredTool, RegisteredTool] {
  const poll = server.registerTool(
    "poll_commands",
    {
      description: "Viewer → server: long-poll for queued commands for this view.",
      inputSchema: { viewUUID: z.string() }
    },
    async ({ viewUUID }) => {
      // Drop the prior `viewUUID === getSession().viewUUID` check: prior
      // iframes (from before the most-recent `open_document`) still need to
      // drain *their* queue to receive the broadcast `close_document`. Each
      // iframe owns its own queue keyed by its viewUUID.
      markViewLive(viewUUID);
      let commands = drainView(viewUUID);
      if (commands.length === 0) {
        await waitForEnqueueOrTimeout(viewUUID, getLongPollTimeoutMs());
        commands = drainView(viewUUID);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ commands }) }],
        structuredContent: { commands }
      };
    }
  );

  // submit_response is single-purpose — it only handles responses to
  // previously queued commands. Unsolicited viewer events (license errors,
  // generic SDK errors) are routed through the `viewer_event` tool below.
  const submit = server.registerTool(
    "submit_response",
    {
      description: "Viewer → server: respond to a previously queued command.",
      inputSchema: {
        requestId: z.string(),
        data: z.unknown().nullable(),
        error: z.string().optional()
      }
    },
    async ({ requestId, data, error }) => {
      if (error) {
        rejectPending(requestId, new Error(error));
      } else {
        resolvePending(requestId, data);
      }
      return { content: [{ type: "text", text: "ok" }] };
    }
  );

  // Dedicated tool for unsolicited viewer → server event pushes.
  // The discriminated `type` field replaces the sentinel requestId strings
  // that submit_response previously overloaded for this purpose.
  const viewerEvent = server.registerTool(
    "viewer_event",
    {
      description: "Viewer → server: push an unsolicited event (license error, SDK error).",
      inputSchema: {
        event: viewerEventSchema.describe("Typed viewer event with discriminated type field")
      }
    },
    async ({ event }: { event: ViewerEvent }) => {
      if (event.type === "license_error") {
        const payload = event.payload as LicenseErrorPayload;
        if (payload.code === LICENSE_ERROR_CODE) {
          setLicenseError(payload);
          const level: LogLevel = payload.subKind === "expired" ? "error" : "warning";
          log(level, "license.error.received", {
            subKind: payload.subKind,
            renewalUrl: getRenewalUrl()
            // NEVER log the license key value.
          });
        }
      } else if (event.type === "viewer_error") {
        log("warning", "viewer.error", {
          message: event.payload.message,
          source: event.payload.source
        });
      }
      return { content: [{ type: "text", text: "ok" }] };
    }
  );

  return [poll, submit, viewerEvent];
}
