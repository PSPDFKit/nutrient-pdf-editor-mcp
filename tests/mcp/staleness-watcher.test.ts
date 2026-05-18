import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startWatching,
  stopWatching,
  __isWatchingForTesting,
} from "../../src/mcp/staleness-watcher.js";
import {
  clearOpenDocument,
  getDocumentCheckpoint,
  isDocumentDirty,
  setDocumentCheckpoint,
  setDocumentDirty,
  setIsPendingSave,
} from "../../src/mcp/session.js";

// fs.watch is OS-driven and asynchronous. Tests poll for the dirty flag
// rather than racing a fixed sleep against fs.watch's variable latency.
async function waitFor(
  cond: () => boolean,
  timeoutMs = 1500,
  stepMs = 25,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise<void>((r) => setTimeout(r, stepMs));
  }
  return cond();
}

describe("staleness-watcher", () => {
  let tmpDir: string;
  let docPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-watcher-"));
    docPath = path.join(tmpDir, "doc.pdf");
    fs.writeFileSync(docPath, Buffer.from("ORIGINAL_CONTENT_v1"));
    setDocumentDirty(false);
    setIsPendingSave(false);
  });

  afterEach(() => {
    stopWatching();
    clearOpenDocument();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("startWatching snapshots size+mtime into the session checkpoint", () => {
    const stat = fs.statSync(docPath);
    startWatching(docPath);
    const cp = getDocumentCheckpoint();
    expect(cp).not.toBeNull();
    expect(cp!.size).toBe(stat.size);
    expect(cp!.mtime).toBe(stat.mtime.getTime());
    expect(__isWatchingForTesting()).toBe(docPath);
  });

  it("startWatching does not crash when the file is missing (just logs)", () => {
    const ghost = path.join(tmpDir, "does-not-exist.pdf");
    expect(() => startWatching(ghost)).not.toThrow();
    expect(__isWatchingForTesting()).toBeNull();
  });

  it("flips the dirty flag when the file is modified externally", async () => {
    startWatching(docPath);
    expect(isDocumentDirty()).toBe(false);

    // Sleep briefly so the new content's mtime is guaranteed to differ from
    // the checkpoint (some filesystems have 1s mtime granularity).
    await new Promise<void>((r) => setTimeout(r, 1100));
    fs.writeFileSync(docPath, Buffer.from("EXTERNAL_EDIT_BY_OTHER_APP"));

    const flipped = await waitFor(() => isDocumentDirty(), 3000);
    expect(flipped).toBe(true);
    // After flipping, the watcher closes itself
    expect(__isWatchingForTesting()).toBeNull();
  });

  it("does NOT flip the dirty flag when isPendingSave is true (self-write suppression)", async () => {
    startWatching(docPath);
    setIsPendingSave(true);

    await new Promise<void>((r) => setTimeout(r, 1100));
    fs.writeFileSync(docPath, Buffer.from("SELF_WRITE_NEW_BYTES"));

    // Wait long enough that any event would have fired
    await new Promise<void>((r) => setTimeout(r, 500));
    expect(isDocumentDirty()).toBe(false);
    // Watcher continues running so future external edits still flip
    expect(__isWatchingForTesting()).toBe(docPath);
  });

  it("does NOT flip when the watcher fires but size+mtime are unchanged (spurious event)", async () => {
    startWatching(docPath);
    const stat = fs.statSync(docPath);
    // Touch with the same mtime — equivalent to a no-op modification that
    // some filesystems might still surface as a watch event.
    fs.utimesSync(docPath, stat.atime, stat.mtime);

    await new Promise<void>((r) => setTimeout(r, 300));
    expect(isDocumentDirty()).toBe(false);
  });

  it("flips the dirty flag when the file is deleted while being watched", async () => {
    startWatching(docPath);
    await new Promise<void>((r) => setTimeout(r, 50));
    fs.unlinkSync(docPath);
    const flipped = await waitFor(() => isDocumentDirty(), 2000);
    expect(flipped).toBe(true);
    expect(__isWatchingForTesting()).toBeNull();
  });

  it("stopWatching is idempotent and safe before any startWatching", () => {
    expect(() => stopWatching()).not.toThrow();
    expect(__isWatchingForTesting()).toBeNull();

    startWatching(docPath);
    stopWatching();
    expect(() => stopWatching()).not.toThrow();
    expect(__isWatchingForTesting()).toBeNull();
  });

  it("startWatching with the same path keeps the watcher and refreshes the checkpoint", () => {
    startWatching(docPath);
    const cp1 = getDocumentCheckpoint();
    expect(cp1).not.toBeNull();
    expect(__isWatchingForTesting()).toBe(docPath);

    // setOpenDocument() clears the checkpoint on every open. A second
    // startWatching on the same path must re-snapshot it so D11 stays armed
    // — re-using a `null` checkpoint silently disables the pre-rename
    // stat-compare.
    setDocumentCheckpoint(null);
    startWatching(docPath);
    const cp2 = getDocumentCheckpoint();
    expect(cp2).toEqual(cp1);
    expect(__isWatchingForTesting()).toBe(docPath);
  });

  it("startWatching with a different path stops the prior watcher", () => {
    const other = path.join(tmpDir, "other.pdf");
    fs.writeFileSync(other, Buffer.from("OTHER"));

    startWatching(docPath);
    expect(__isWatchingForTesting()).toBe(docPath);

    startWatching(other);
    expect(__isWatchingForTesting()).toBe(other);

    const cp = getDocumentCheckpoint();
    expect(cp!.size).toBe(fs.statSync(other).size);
  });

  it("P1-13: sets documentDirty=true (fail-closed) when fs.watch init throws", () => {
    // Force fs.watch to throw to simulate EMFILE or unsupported filesystem.
    const watchSpy = vi
      .spyOn(fs, "watch")
      .mockImplementationOnce(() => {
        throw new Error("EMFILE: too many open files");
      });

    setDocumentDirty(false);
    startWatching(docPath);

    // After a watch-init failure the dirty flag must be true so every
    // subsequent operating-tool call throws rather than silently operating
    // on potentially-stale bytes.
    expect(isDocumentDirty()).toBe(true);
    // No watcher is registered (the init threw before we could set `active`).
    expect(__isWatchingForTesting()).toBeNull();

    watchSpy.mockRestore();
  });
});
