import fs from "node:fs";
import {
  getDocumentCheckpoint,
  isPendingSave,
  setDocumentCheckpoint,
  setDocumentDirty
} from "./session.js";
import { log } from "./logger.js";

/**
 * Per-document fs.watch wrapper that flips the session's `documentDirty`
 * flag when the open document is modified externally (i.e., not by our
 * own atomic write-back).
 *
 *   1. `startWatching(documentPath)` snapshots `size + mtime` into the
 *      session checkpoint and starts a native `fs.watch(documentPath)`.
 *      Idempotent — re-calling with the same path is a no-op; with a
 *      different path it stops the prior watcher first.
 *   2. The watcher callback is filtered against the session's
 *      `isPendingSave` flag (set by `write_document_bytes` immediately
 *      before its atomic rename, cleared shortly after) so our own
 *      writeback does not flip the dirty flag.
 *   3. On a non-self event the watcher re-stats the file. If `size + mtime`
 *      differs from the checkpoint, `setDocumentDirty(true)` is called and
 *      the watcher is closed — further events are noise; the user must
 *      `close_document` + `open_document` to recover (no merge, no live
 *      reload, by spec D7 / Q4).
 *
 * Process exit: `stopWatching()` should be called from `clearOpenDocument`
 * (via `close_document` and the in-place SDK swap path). It is idempotent
 * and exception-safe so callers can invoke it unconditionally.
 *
 * Single-process and two-process MCPB modes share the same module: the
 * watcher only runs in the process that handled `open_document` (the
 * roots process in two-process mode). The other process reads the
 * `isDocumentDirty()` and `isPendingSave()` flags via the file-backed
 * SessionBackend, which bridges them across the process boundary.
 */

interface ActiveWatch {
  documentPath: string;
  watcher: fs.FSWatcher;
}

let active: ActiveWatch | null = null;

export function startWatching(documentPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(documentPath);
  } catch (err) {
    log("warning", "staleness-watcher.stat-failed", {
      documentPath,
      error: String(err)
    });
    return;
  }

  // Always (re-)snapshot the checkpoint. `setOpenDocument()` clears the
  // checkpoint on every open (so a stale dirty flag from a prior path can't
  // leak into the new session), so even the same-path re-open branch must
  // repopulate it — otherwise D11 silently degrades to "no checkpoint, skip
  // the pre-rename stat-compare".
  setDocumentCheckpoint({
    size: stat.size,
    mtime: stat.mtime.getTime()
  });

  if (active && active.documentPath === documentPath) {
    return;
  }
  if (active) {
    stopWatching();
  }

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(documentPath, () => {
      onChange(documentPath);
    });
  } catch (err) {
    // fs.watch init failed (e.g. EMFILE, unsupported filesystem). Fail-closed:
    // mark the document dirty so every subsequent operating tool throws rather
    // than silently operating on potentially stale bytes. The user must
    // close_document + open_document to recover.
    setDocumentDirty(true);
    log("warning", "staleness-watcher.watch-failed", {
      documentPath,
      error: String(err)
    });
    return;
  }

  watcher.on("error", (err) => {
    log("warning", "staleness-watcher.watcher-error", {
      documentPath,
      error: String(err)
    });
  });

  active = { documentPath, watcher };
  log("info", "staleness-watcher.started", {
    documentPath,
    size: stat.size,
    mtime: stat.mtime.getTime()
  });
}

export function stopWatching(): void {
  if (active === null) return;
  const documentPath = active.documentPath;
  try {
    active.watcher.close();
  } catch {
    /* best-effort */
  }
  active = null;
  log("info", "staleness-watcher.stopped", { documentPath });
}

/**
 * Test-only: returns whether the module currently holds an active watcher.
 * Production code uses `startWatching` idempotency rather than this probe.
 */
export function __isWatchingForTesting(): string | null {
  return active === null ? null : active.documentPath;
}

function onChange(documentPath: string): void {
  if (isPendingSave()) {
    log("info", "staleness-watcher.self-write-suppressed", { documentPath });
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(documentPath);
  } catch (err) {
    // File deleted / inaccessible — treat as stale and stop watching.
    log("info", "staleness-watcher.stat-on-change-failed", {
      documentPath,
      error: String(err)
    });
    setDocumentDirty(true);
    stopWatching();
    return;
  }

  const checkpoint = getDocumentCheckpoint();
  const size = stat.size;
  const mtime = stat.mtime.getTime();

  if (checkpoint !== null && checkpoint.size === size && checkpoint.mtime === mtime) {
    // fs.watch can fire spurious events on macOS even when nothing material
    // changed (e.g., touch + restore mtime). If size+mtime are unchanged
    // there is no edit to surface — keep watching.
    return;
  }

  log("info", "staleness-watcher.external-change", {
    documentPath,
    checkpointSize: checkpoint?.size ?? null,
    checkpointMtime: checkpoint?.mtime ?? null,
    currentSize: size,
    currentMtime: mtime
  });
  setDocumentDirty(true);
  stopWatching();
}
