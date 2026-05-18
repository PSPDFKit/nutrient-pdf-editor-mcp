import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import {
  clearOpenDocument,
  getLiveViewUUIDs,
  getSession,
  setActiveViewUUID,
  setOpenDocument
} from "../session.js";
import { enqueueAndWaitForView, readPositiveFiniteEnvMs } from "../bridge.js";
import { validatePathInAllowedRootsAtOpenTime } from "../path-guard.js";
import { VIEWER_RESOURCE_URI } from "../app-resource.js";
import { startWatching, stopWatching } from "../staleness-watcher.js";
import { log } from "../logger.js";

interface OpenResult extends Record<string, unknown> {
  documentPath: string;
  viewUUID: string;
}

/**
 * Bound on how long we wait for prior iframes to ack a `close_document`
 * during the broadcast that runs at the start of every `open_document`.
 * Short on purpose — if an iframe doesn't ack in 2 s it's likely already
 * dead (Cowork unmounted it without a teardown notification) and we don't
 * want to block the new conversation's `open_document` for the full
 * `VIEWER_TIMEOUT_MS` (default 30 s) per dead iframe.
 *
 * Overridable via `CLOSE_BROADCAST_TIMEOUT_MS` env var (positive integer
 * ms; falls back to 2000 if unset/malformed). Tests use this to shrink
 * the wait so the timeout-fallback case isn't a multi-second slog.
 */
function getCloseBroadcastTimeoutMs(): number {
  return readPositiveFiniteEnvMs("CLOSE_BROADCAST_TIMEOUT_MS", 2000);
}

/**
 * Bound on how recently a viewUUID must have polled to be considered
 * "live" enough that we'll bother enqueueing a close to it. If it hasn't
 * polled in this window, skip — the iframe is gone or unresponsive and
 * waiting on it is dead time.
 */
const LIVE_VIEW_STALE_AFTER_MS = 5000;

export function registerOpenDocument(server: McpServer): RegisteredTool {
  return registerAppTool(
    server,
    "open_document",
    {
      title: "Open document",
      description:
        "Use this when the user references a document file (PDF, DOCX, XLSX, PPTX, PNG, JPG, TIFF) — " +
        "opens it in a visible Nutrient viewer iframe so the user can see the work. Always the first " +
        "call in a document workflow; required before any other tool. Calling this " +
        "again with a different path replaces the loaded document in the same viewer (the iframe " +
        "swaps to the new SDK instance once it has loaded). Returns as soon as the path is validated; " +
        "the viewer loads asynchronously (typically 0.5–3 seconds). Wait for this tool's response " +
        "before calling any other tool, and do not issue subsequent tool calls in " +
        'parallel with this one. If a follow-up returns "Document not open" or "document is still ' +
        'loading" right after open, the load was still in flight — wait briefly and retry the ' +
        "follow-up tool (do NOT retry open_document).",
      inputSchema: {
        path: z.string().describe("Absolute path under a VirtIO-mounted root.")
      },
      annotations: {},
      _meta: { ui: { resourceUri: VIEWER_RESOURCE_URI } }
    },
    async ({ path: input }) => {
      const { viewUUID: priorActiveViewUUID } = getSession();
      log("info", "open_document.called", { input, priorActiveViewUUID });
      const abs = validatePathInAllowedRootsAtOpenTime(input);
      if (!fs.existsSync(abs)) {
        log("error", "open_document.not_found", { input, resolved: abs });
        throw new McpError(ErrorCode.InvalidParams, `File not found: ${abs}`);
      }

      // Broadcast `close_document` to every recently-live prior view so
      // their iframes tear down their SDK and render the
      // "Reopen the document to continue" placeholder. Single-iframe-at-a-
      // time semantics (option C from the multi-conversation investigation):
      // any prior conversation's viewer becomes blank when a new one opens.
      // The user is shown a clear "ask the assistant to open <file> again"
      // message in the prior conversation when they switch back.
      //
      // The new viewUUID is generated BEFORE the broadcast so we can exclude
      // it from the close list (defensively — it shouldn't be live yet, but
      // an iframe that polled with this UUID for any reason wouldn't get
      // closed by its own open).
      const newViewUUID = randomUUID();
      const targets = getLiveViewUUIDs(LIVE_VIEW_STALE_AFTER_MS).filter(
        (uuid) => uuid !== newViewUUID
      );
      if (targets.length > 0) {
        log("info", "open_document.broadcast_close.start", {
          targetCount: targets.length,
          targets,
          newViewUUID
        });
        const closes = targets.map(async (targetUUID) => {
          const requestId = randomUUID();
          try {
            await enqueueAndWaitForView(
              targetUUID,
              { type: "close_document", requestId },
              requestId,
              getCloseBroadcastTimeoutMs()
            );
            log("info", "open_document.broadcast_close.acked", {
              targetUUID,
              requestId
            });
          } catch (err) {
            // Best-effort. If the prior iframe doesn't respond within
            // CLOSE_BROADCAST_TIMEOUT_MS we proceed anyway — the iframe is
            // either dead or unresponsive, and we should not block the
            // model's new open on it.
            log("warning", "open_document.broadcast_close.no_ack", {
              targetUUID,
              requestId,
              error: String(err)
            });
          }
        });
        await Promise.allSettled(closes);
      }

      // Clear server state from the prior open before mutating to the new
      // one so the freshness flags and watcher don't leak across the
      // conversation boundary. (setOpenDocument also resets FS_SYNC, but
      // we explicitly stopWatching() the prior path here too.)
      stopWatching();
      clearOpenDocument();

      setActiveViewUUID(newViewUUID);
      setOpenDocument(abs);
      // Start watching the document for external edits. The watcher snapshots
      // size+mtime into the session checkpoint and flips documentDirty=true
      // on any non-self change, surfaced to the model on the next operating
      // tool via requireFreshDocument().
      startWatching(abs);

      const result: OpenResult = { documentPath: abs, viewUUID: newViewUUID };

      log("info", "open_document.returning", {
        documentPath: abs,
        viewUUID: newViewUUID,
        resourceUri: VIEWER_RESOURCE_URI
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        _meta: {
          viewUUID: newViewUUID,
          ui: { resourceUri: VIEWER_RESOURCE_URI }
        }
      };
    }
  );
}
