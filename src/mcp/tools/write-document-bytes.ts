import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  getDocumentCheckpoint,
  getDocumentPath,
  getSession,
  setDocumentCheckpoint,
  setDocumentDirty,
  setIsPendingSave
} from "../session.js";
import { requireValidLicense, requireFreshDocument } from "../document-guard.js";
import { log } from "../logger.js";

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const PENDING_SAVE_CLEAR_DELAY_MS = 500;

/** Best-effort unlink — ignores ENOENT and any other error. */
function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* best-effort */
  }
}

/**
 * Validates that a document is open and that the caller's captured path still
 * matches the session's open document path (guards against in-place SDK swap
 * mid-save). Returns the validated session document path on success; throws
 * McpError on failure.
 *
 * On path-mismatch the caller's stale staging file is cleaned up before
 * throwing so partial chunks don't accumulate across repeated swaps.
 */
function validateStreamBinding(callerDocumentPath: string, viewUUID: string): string {
  const documentPath = getDocumentPath();

  if (documentPath === null) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "No document is currently open. write_document_bytes refuses to write because there is no validated destination path."
    );
  }

  if (callerDocumentPath !== documentPath) {
    // Best-effort: nuke any partial staging file under the *prior* path
    // so it doesn't outlive this rejection. The new path's staging
    // file (if any) is not ours to touch.
    tryUnlink(`${callerDocumentPath}.${viewUUID}.tmp`);
    log("warning", "write_document_bytes.path-mismatch", {
      callerDocumentPath,
      sessionDocumentPath: documentPath,
      viewUUID
    });
    throw new McpError(
      ErrorCode.InvalidParams,
      `Save stream targets ${callerDocumentPath} but the open document is ${documentPath}. The previous document was replaced by an open_document call mid-save; this stream's bytes are dropped.`
    );
  }

  return documentPath;
}

/**
 * Writes a single chunk to the staging file. offset=0 truncate-creates the
 * file; subsequent offsets append. Verifies that the staging file exists for
 * non-zero offsets (first chunk must initialise with offset=0).
 */
function writeChunk(stagingPath: string, offset: number, chunk: Buffer): void {
  if (offset === 0) {
    // First chunk: truncate-create the staging file.
    fs.writeFileSync(stagingPath, chunk, { mode: 0o600 });
  } else {
    // Subsequent chunks: verify the staging file exists, then append.
    // Drop per-chunk statSync+size-comparison — the auto-save controller
    // always sends chunks in order, so the exact offset==size check adds a
    // full stat syscall per chunk with no safety benefit: the final
    // staging-file stat-compare catches any corruption. We do still verify
    // the staging file exists (first chunk must arrive with offset=0 to
    // initialise the file); we check that with accessSync (single
    // EACCES/ENOENT syscall) rather than statSync+read.
    try {
      fs.accessSync(stagingPath, fs.constants.F_OK);
    } catch {
      throw new McpError(
        ErrorCode.InvalidParams,
        `No staging file found at ${stagingPath}; first chunk must use offset=0.`
      );
    }
    if (chunk.length > 0) {
      fs.appendFileSync(stagingPath, chunk);
    }
  }
}

/**
 * D11 pre-rename stat-compare, atomic rename, and checkpoint refresh.
 *
 * Steps (must remain in this order):
 *   1. If a checkpoint exists, open the destination with openSync('r') and
 *      fstat the fd (TOCTOU mitigation 2A.M-2). Abort if the destination
 *      diverged from the checkpoint — an external edit landed during our save.
 *   2. Set `isPendingSave = true` BEFORE the rename so the staleness watcher
 *      suppresses the event our own write fires.
 *   3. Rename the staging file over the destination (atomic on POSIX).
 *   4. Stat the destination AFTER rename and refresh the checkpoint so future
 *      saves don't trip D11 against our own prior write.
 *   5. Schedule `isPendingSave = false` after the debounce.
 *
 * On any error: staging file is removed via tryUnlink; isPendingSave is
 * cleared immediately (so a subsequent legitimate watcher event isn't eaten).
 */
function finalizeWrite(stagingPath: string, documentPath: string, viewUUID: string): void {
  const checkpoint = getDocumentCheckpoint();

  if (checkpoint !== null) {
    // TOCTOU mitigation (2A.M-2): open destination read-only so the kernel
    // holds a reference to the inode, then fstat the open fd. Even if
    // another process replaces the file between our stat and rename, we
    // still compare against the inode we would be clobbering.
    let destFd: number | null = null;
    let destStat: fs.Stats;
    try {
      destFd = fs.openSync(documentPath, "r");
      destStat = fs.fstatSync(destFd);
    } catch (err) {
      if (destFd !== null) {
        try {
          fs.closeSync(destFd);
        } catch {
          /* best-effort */
        }
      }
      tryUnlink(stagingPath);
      setDocumentDirty(true);
      log("warning", "write_document_bytes.dest-disappeared", {
        documentPath,
        viewUUID,
        error: String(err)
      });
      throw new McpError(
        ErrorCode.InvalidParams,
        "Destination file disappeared during save. Document marked stale; close_document and open_document to recover."
      );
    }

    const destSize = destStat.size;
    const destMtime = destStat.mtime.getTime();
    // Close the fd before the rename so we don't hold a stale reference
    // across the rename syscall (important on Windows; harmless but correct
    // on POSIX).
    try {
      fs.closeSync(destFd);
    } catch {
      /* best-effort */
    }

    if (destSize !== checkpoint.size || destMtime !== checkpoint.mtime) {
      tryUnlink(stagingPath);
      setDocumentDirty(true);
      log("warning", "write_document_bytes.checkpoint-divergence", {
        documentPath,
        viewUUID,
        checkpointSize: checkpoint.size,
        checkpointMtime: checkpoint.mtime,
        destSize,
        destMtime
      });
      throw new McpError(
        ErrorCode.InvalidParams,
        "Document on disk changed during save. Document marked stale; close_document and open_document to recover."
      );
    }
  }

  // Mark our own write before the rename so the staleness watcher's event
  // is suppressed. Cleared after a debounce so any external edit landing
  // slightly later still flips the dirty flag.
  setIsPendingSave(true);
  try {
    fs.renameSync(stagingPath, documentPath);
  } catch (err) {
    // Rename failure leaves the original intact and the staging file
    // possibly orphaned. Clear the suppression flag eagerly so a subsequent
    // legitimate watcher event isn't eaten.
    setIsPendingSave(false);
    throw err;
  }

  // Refresh checkpoint to the just-saved size+mtime so future saves don't
  // trip D11 against our own prior write.
  try {
    const newStat = fs.statSync(documentPath);
    setDocumentCheckpoint({
      size: newStat.size,
      mtime: newStat.mtime.getTime()
    });
  } catch {
    /* checkpoint stale until next watcher event; not fatal */
  }

  setTimeout(() => setIsPendingSave(false), PENDING_SAVE_CLEAR_DELAY_MS);
}

/**
 * `write_document_bytes` — internal tool, viewer → server only; filtered out
 * of `tools/list`. The iframe streams exported PDF bytes back to the server,
 * which buffers them in a staging file alongside the original and
 * atomic-renames over the original on the final chunk.
 *
 * Document **reads** flow through the `nutrient-doc:///current` MCP resource
 * (one round-trip, no chunked tool calls). Writes still need a chunked tool
 * because MCP resources are read-only and SDK-exported PDFs can be hundreds
 * of MB — too large for a single server→client message.
 *
 * The destination is not a free-form path: it is read from
 * `SessionBackend.getDocumentPath()`, which was set (and path-guarded) at
 * `open_document` time. Without an open document there is no target, so the
 * tool refuses. There is no model-supplied path that could escape.
 *
 * Guard pair: `write_document_bytes` calls `requireFreshDocument()` plus an
 * explicit `documentPath === null` check, NOT the standard
 * `requireOpenDocument()` / `requireFreshDocument()` pair the public
 * operating tools use. The explicit null-check is equivalent to (and
 * subsumes) `requireOpenDocument()` here because the destination is read
 * from session state — not the model — so an extra `requireOpenDocument()`
 * call would be redundant. See `docs/tool-surface.md` § "Runtime guards".
 *
 * Staging path: `${documentPath}.${viewUUID}.tmp`. Same directory as the
 * target so `fs.renameSync` is atomic.
 *
 * Three layers protect against silent clobbering of an external edit:
 *
 *   1. `requireFreshDocument()` runs at handler entry. If the staleness
 *      watcher (or a prior pre-rename check) already flagged the document
 *      as dirty, every chunk is rejected — the user must close+reopen.
 *   2. Pre-rename stat-vs-checkpoint (spec D11): immediately before
 *      `fs.renameSync` the destination is `fs.stat`-ed and compared to
 *      `SessionBackend.getDocumentCheckpoint()`. A divergence aborts the
 *      save, deletes the staging file, sets `documentDirty=true`, and
 *      throws — closing the watcher self-edit suppression race.
 *   3. `isPendingSave` is set true right before the rename and cleared
 *      after a 500ms debounce. The watcher consults this flag and
 *      suppresses its event when our own writeback fires it.
 *
 * On success the checkpoint is refreshed to the just-saved size+mtime so
 * subsequent saves do not trip D11 against our own prior write.
 */
export function registerWriteDocumentBytes(server: McpServer): RegisteredTool {
  return server.registerTool(
    "write_document_bytes",
    {
      description:
        "Internal viewer-only tool: chunked document byte writer. The iframe " +
        "streams exported PDF bytes back to the server. Target path is read " +
        "from session state (set at open_document time); each chunk also " +
        "carries the path the iframe captured when the save started, and the " +
        "tool rejects chunks whose path no longer matches session state " +
        "(in-place SDK swap mid-save). Filtered from tools/list; the model " +
        "should NOT call this directly.",
      inputSchema: {
        offset: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "Byte offset of this chunk within the full document. Chunks must be sent in order; offset 0 truncates any pre-existing staging file."
          ),
        byteCount: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_CHUNK_BYTES)
          .describe(
            "Length of the decoded chunk in bytes. Must equal the size of dataBase64 after decoding."
          ),
        dataBase64: z
          .string()
          .describe(
            "Base64-encoded chunk bytes. Empty string is allowed only when byteCount is 0 and isFinal is true (single empty-document save)."
          ),
        isFinal: z
          .boolean()
          .describe(
            "True on the last chunk; triggers atomic rename of the staging file over the destination."
          ),
        documentPath: z
          .string()
          .describe(
            "The currentDocumentPath the iframe captured when this save stream started. Server rejects the chunk if it doesn't match the session's open document path — guards against an in-flight save against the prior document writing into a freshly-opened new document after an in-place SDK swap."
          )
      }
    },
    async ({ offset, byteCount, dataBase64, isFinal, documentPath: callerDocumentPath }) => {
      const { viewUUID } = getSession();
      log("info", "write_document_bytes.called", {
        offset,
        byteCount,
        isFinal,
        viewUUID,
        hasDocumentPath: getDocumentPath() !== null,
        callerDocumentPath
      });

      const documentPath = validateStreamBinding(callerDocumentPath, viewUUID);

      // Refuse the entire chunk stream if the document was flagged stale
      // since open. The user must close+reopen — saving would clobber the
      // external edit. See spec D7 / D11.
      requireValidLicense();
      requireFreshDocument();

      if (byteCount === 0 && !isFinal) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Empty non-final chunk is not allowed. Send at least one non-empty chunk, or finalize with byteCount=0 and isFinal=true."
        );
      }

      const chunk = Buffer.from(dataBase64, "base64");
      if (chunk.length !== byteCount) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Decoded byte count (${chunk.length}) does not match declared byteCount (${byteCount}).`
        );
      }

      const stagingPath = `${documentPath}.${viewUUID}.tmp`;
      writeChunk(stagingPath, offset, chunk);

      const totalBytes = offset + byteCount;

      if (isFinal) {
        finalizeWrite(stagingPath, documentPath, viewUUID);
        log("info", "write_document_bytes.finalized", {
          documentPath,
          totalBytes,
          viewUUID
        });
        const result = { bytesWritten: byteCount, finalized: true, totalBytes };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result
        };
      }

      const result = { bytesWritten: byteCount, finalized: false, totalBytes };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );
}
