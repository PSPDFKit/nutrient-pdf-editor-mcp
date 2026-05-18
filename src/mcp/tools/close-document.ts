import { randomUUID } from "node:crypto";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSession, hasOpenDocument, clearOpenDocument } from "../session.js";
import { enqueueAndWait } from "../bridge.js";
import { stopWatching } from "../staleness-watcher.js";
import { log } from "../logger.js";

export function registerCloseDocumentTool(server: McpServer): RegisteredTool {
  return server.registerTool(
    "close_document",
    {
      title: "Close document",
      description:
        "Use when the document workflow is complete and you want to free the viewer — tears down the SDK instance and clears server-side session state. Not required between documents (open_document auto-replaces). Idempotent: calling when no document is open is a successful no-op.",
      inputSchema: {},
      annotations: {}
    },
    async () => {
      const { viewUUID } = getSession();
      log("info", "close_document.called", {
        sessionViewUUID: viewUUID,
        hasOpenDocument: hasOpenDocument()
      });
      const result = { closed: true };

      // Idempotent: when a document is open, ack from the iframe and clear
      // server state; when nothing is open, skip the round-trip (the iframe
      // may not even be polling yet) and return success directly. Both arms
      // produce the same `result`, so there is a single return below.
      if (hasOpenDocument()) {
        const requestId = randomUUID();

        // Best-effort wait for iframe ack. close_document intentionally
        // swallows both timeout and viewer-error rejections from the shared
        // helper — server state must be cleared even if the iframe never
        // responds.
        try {
          await enqueueAndWait({ type: "close_document", requestId }, requestId);
        } catch (err) {
          log("warning", "close_document.no_ack", { error: String(err) });
        }

        stopWatching();
        clearOpenDocument();
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        _meta: { viewUUID }
      };
    }
  );
}
