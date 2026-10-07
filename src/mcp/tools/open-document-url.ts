import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import {
  addOwnedView,
  clearOpenDocument,
  getLiveViewUUIDs,
  getSession,
  isOwnedView,
  isScopedSession,
  setActiveViewUUID,
  setOpenDocument
} from "../session.js";
import { enqueueAndWaitForView, readPositiveFiniteEnvMs } from "../bridge.js";
import { VIEWER_RESOURCE_URI } from "../app-resource.js";
import { stopWatching } from "../staleness-watcher.js";
import { fetchRemoteDocument } from "../remote-documents.js";
import { log } from "../logger.js";

interface OpenUrlResult extends Record<string, unknown> {
  documentPath: string;
  viewUUID: string;
  fileName: string;
  byteLength: number;
  source: string;
}

const LIVE_VIEW_STALE_AFTER_MS = 5000;

/**
 * Close prior viewers before a new open. In a hosted (scoped) session only
 * this session's own viewers are closed, never another user's.
 */
export async function closePriorViews(newViewUUID: string): Promise<void> {
  const targets = getLiveViewUUIDs(LIVE_VIEW_STALE_AFTER_MS).filter(
    (uuid) => uuid !== newViewUUID && (!isScopedSession() || isOwnedView(uuid))
  );
  if (targets.length === 0) return;
  const timeout = readPositiveFiniteEnvMs("CLOSE_BROADCAST_TIMEOUT_MS", 2000);
  await Promise.allSettled(
    targets.map(async (targetUUID) => {
      const requestId = randomUUID();
      try {
        await enqueueAndWaitForView(
          targetUUID,
          { type: "close_document", requestId },
          requestId,
          timeout
        );
      } catch (err) {
        log("warning", "open_document_url.broadcast_close.no_ack", {
          targetUUID,
          error: String(err)
        });
      }
    })
  );
}

/**
 * `open_document_url` — opens a document from an HTTPS download link in the
 * Nutrient viewer. Built for the Salesforce flow: the "Nutrient: Generate
 * Document" action returns `viewerUrl`, and Claude passes it here.
 */
export function registerOpenDocumentUrl(server: McpServer): RegisteredTool {
  return registerAppTool(
    server,
    "open_document_url",
    {
      title: "Open document from URL",
      description:
        "Opens a document from an HTTPS download link in a visible Nutrient viewer inside the chat, so the user can view and edit it. " +
        "Use this right after a Salesforce Nutrient generation action returns a viewerUrl (the 'Viewer Download URL' output of " +
        "'Nutrient: Generate Document'). Pass that URL unchanged. Supports PDF, DOCX, XLSX, PPTX and images. " +
        "Required before any other viewer tool. Returns as soon as the file is downloaded; the viewer renders asynchronously " +
        "(typically 1-3 seconds). Wait for this response before calling other tools, and do not call them in parallel with it. " +
        "If a follow-up tool says the document is still loading, wait briefly and retry that tool, not this one. " +
        "Edits the user makes stay in the viewer for this conversation; they are not written back to Salesforce.",
      inputSchema: {
        url: z
          .string()
          .url()
          .describe(
            "HTTPS download URL of the document, for example the viewerUrl returned by 'Nutrient: Generate Document'."
          ),
        fileName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Optional file name to show, including extension (for example 'Quote - Acme.pdf'). Pass the action's fileName output when available."
          )
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
      _meta: { ui: { resourceUri: VIEWER_RESOURCE_URI } }
    },
    async ({ url, fileName }) => {
      const { viewUUID: priorActiveViewUUID } = getSession();
      log("info", "open_document_url.called", { priorActiveViewUUID });
      const remote = await fetchRemoteDocument(url, fileName);

      const newViewUUID = randomUUID();
      await closePriorViews(newViewUUID);

      stopWatching();
      clearOpenDocument();
      setActiveViewUUID(newViewUUID);
      addOwnedView(newViewUUID);
      setOpenDocument(remote.documentPath);

      const result: OpenUrlResult = {
        documentPath: remote.documentPath,
        viewUUID: newViewUUID,
        fileName: remote.fileName,
        byteLength: remote.bytes.length,
        source: remote.sourceHost
      };
      log("info", "open_document_url.returning", {
        viewUUID: newViewUUID,
        fileName: remote.fileName,
        byteLength: remote.bytes.length
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              opened: true,
              fileName: remote.fileName,
              byteLength: remote.bytes.length
            })
          }
        ],
        structuredContent: result,
        _meta: { viewUUID: newViewUUID, ui: { resourceUri: VIEWER_RESOURCE_URI } }
      };
    }
  );
}
