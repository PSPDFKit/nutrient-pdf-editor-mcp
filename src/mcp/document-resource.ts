import fs from "node:fs";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getSession } from "./session.js";
import { log } from "./logger.js";

/**
 * URI template for the open-document bytes resource. The iframe MUST
 * include `?path=<encoded-document-path>` matching the path it intends
 * to load (the path it captured from the originating `open_document`
 * tool result). The handler:
 *
 *   - Returns base64 bytes if the iframe's path matches `STATE.documentPath`.
 *   - Throws `McpError(InvalidRequest, "stale-document-path: …")` if the
 *     iframe's path differs from session state. The iframe-side
 *     `fetchDocumentBytes` recognises this prefix and renders the
 *     "Reopen the document to continue" placeholder rather than loading
 *     the wrong document.
 *
 * This guards against a fresh iframe being mounted in an old conversation
 * (which Cowork rehydrates with the prior `open_document` tool result)
 * while the server's session has been rolled by a different conversation's
 * `open_document`. Without the path-match guard, the iframe would
 * silently load the other conversation's document. See
 * `docs/document-lifecycle.md` § "Cross-conversation resource-read guard".
 *
 * The bare `nutrient-doc:///current` form (no `?path`) is NOT registered
 * — every caller must include `?path` so the cross-conversation guard
 * always fires.
 */
export const DOCUMENT_RESOURCE_URI_BASE = "nutrient-doc:///current";

/**
 * RFC 6570 URI template registered with the SDK. `{?path}` is form-style
 * query expansion — the SDK matches `nutrient-doc:///current?path=…`
 * against this template and extracts the (URL-encoded) `path` value.
 */
const DOCUMENT_RESOURCE_URI_TEMPLATE = `${DOCUMENT_RESOURCE_URI_BASE}{?path}`;

/**
 * Sentinel prefix on `McpError.message` returned when the iframe's
 * requested path doesn't match the server's session. The iframe matches
 * on this prefix to decide whether to render the "Reopen the document"
 * placeholder rather than propagating the error as a generic load failure.
 */
export const STALE_PATH_ERROR_PREFIX = "stale-document-path:";

export function registerCurrentDocumentResource(server: McpServer): void {
  // Template-only — the bare `nutrient-doc:///current` form is not
  // registered, so every reader is forced through the cross-conversation
  // guard. `list: undefined` keeps the resource off `resources/list`
  // since it's iframe-internal.
  const template = new ResourceTemplate(DOCUMENT_RESOURCE_URI_TEMPLATE, {
    list: undefined
  });
  server.registerResource(
    "current-document",
    template,
    {
      description:
        "Bytes of the currently-open document, with cross-conversation path guard. Iframe-internal; not for direct model use. The iframe sends `?path=<encoded>` matching its intended load path; mismatched path returns the `stale-document-path:` sentinel so the iframe can render the 'Reopen the document' placeholder.",
      mimeType: "application/octet-stream"
    },
    async (uri, variables) => {
      // RFC 6570 `{?path}` extraction is URL-encoded by the SDK
      // (form-style operator does not decode). decodeURIComponent
      // restores the original path string.
      const rawPath = variables?.path;
      const encoded =
        typeof rawPath === "string"
          ? rawPath
          : Array.isArray(rawPath)
            ? (rawPath[0] ?? null)
            : null;
      if (encoded === null || encoded === "") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required \`?path\` query parameter on ${DOCUMENT_RESOURCE_URI_BASE}.`
        );
      }
      let requestedPath: string;
      try {
        requestedPath = decodeURIComponent(encoded);
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `Malformed percent-encoded path: ${encoded}`);
      }

      const { documentPath, viewUUID } = getSession();
      log("info", "current_document_resource.read", {
        uri: uri.href,
        sessionDocumentPath: documentPath,
        requestedPath,
        viewUUID
      });
      if (!documentPath) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No document is open. Call open_document first."
        );
      }
      // Cross-conversation guard. Mismatch means a fresh iframe was
      // rehydrated in an old conversation while the active session
      // belongs to a different conversation — serving bytes here
      // would silently load the wrong document.
      if (requestedPath !== documentPath) {
        log("warning", "current_document_resource.stale_path", {
          requestedPath,
          sessionDocumentPath: documentPath,
          viewUUID
        });
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${STALE_PATH_ERROR_PREFIX} requested ${requestedPath} but session has ${documentPath}`
        );
      }
      const buf = await fs.promises.readFile(documentPath);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/octet-stream",
            blob: buf.toString("base64")
          }
        ]
      };
    }
  );
}
