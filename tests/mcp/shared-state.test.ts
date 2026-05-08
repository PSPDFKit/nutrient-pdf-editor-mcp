import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSharedFileBackend } from "../../src/mcp/shared-state/file-backend.js";

describe("shared-state file backend", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-shared-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(stateDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  it("two backend instances share viewUUID", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    expect(a.getViewUUID()).toBe(b.getViewUUID());
    expect(a.getViewUUID()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("enqueue in A is drained by B", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    a.enqueue({ type: "get_view_state", requestId: "r1" });
    a.enqueue({ type: "read_document_information", requestId: "r2" });
    const drained = b.drain();
    expect(drained).toEqual([
      { type: "get_view_state", requestId: "r1" },
      { type: "read_document_information", requestId: "r2" },
    ]);
    expect(a.drain()).toEqual([]);
  });

  it("documentPath is visible across instances", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    expect(b.hasOpenDocument()).toBe(false);
    a.setOpenDocument("/tmp/foo.pdf");
    expect(b.hasOpenDocument()).toBe(true);
    expect(b.getDocumentPath()).toBe("/tmp/foo.pdf");
    a.clearOpenDocument();
    expect(b.hasOpenDocument()).toBe(false);
  });

  it("resolvePending in B unblocks registerPending in A", async () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    const promise = a.registerPending("req-1");
    setTimeout(() => b.resolvePending("req-1", { ok: true, n: 42 }), 20);
    const result = await promise;
    expect(result).toEqual({ ok: true, n: 42 });
  });

  it("rejectPending in B propagates to A as a rejection", async () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    const promise = a.registerPending("req-2");
    setTimeout(() => b.rejectPending("req-2", new Error("nope")), 20);
    await expect(promise).rejects.toThrow("nope");
  });

  it("documentDirty flag is shared across instances", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    expect(b.isDocumentDirty()).toBe(false);
    a.setDocumentDirty(true);
    expect(b.isDocumentDirty()).toBe(true);
    b.setDocumentDirty(false);
    expect(a.isDocumentDirty()).toBe(false);
  });

  it("documentCheckpoint is shared across instances", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    expect(b.getDocumentCheckpoint()).toBe(null);
    a.setDocumentCheckpoint({ size: 12345, mtime: 1700000000000 });
    expect(b.getDocumentCheckpoint()).toEqual({
      size: 12345,
      mtime: 1700000000000,
    });
    a.setDocumentCheckpoint(null);
    expect(b.getDocumentCheckpoint()).toBe(null);
  });

  it("isPendingSave is shared across instances", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    expect(b.isPendingSave()).toBe(false);
    a.setIsPendingSave(true);
    expect(b.isPendingSave()).toBe(true);
    b.setIsPendingSave(false);
    expect(a.isPendingSave()).toBe(false);
  });

  it("clearOpenDocument resets dirty / checkpoint / pending-save", () => {
    const a = createSharedFileBackend({ stateDir });
    const b = createSharedFileBackend({ stateDir });
    a.setOpenDocument("/foo.pdf");
    a.setDocumentDirty(true);
    a.setDocumentCheckpoint({ size: 1, mtime: 2 });
    a.setIsPendingSave(true);

    a.clearOpenDocument();

    expect(b.hasOpenDocument()).toBe(false);
    expect(b.isDocumentDirty()).toBe(false);
    expect(b.getDocumentCheckpoint()).toBe(null);
    expect(b.isPendingSave()).toBe(false);
  });

  it("read() backfills new fields when the persisted state file is missing them", () => {
    // Simulate a state file written by a prior version of the backend that
    // didn't know about the fs-sync fields. Reading must still succeed and
    // surface the new fields with their default values.
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({
        viewUUID: "00000000-0000-0000-0000-000000000000",
        queue: [],
        documentPath: null,
        results: {},
        activePids: [],
      }),
    );
    const backend = createSharedFileBackend({ stateDir });
    expect(backend.isDocumentDirty()).toBe(false);
    expect(backend.getDocumentCheckpoint()).toBe(null);
    expect(backend.isPendingSave()).toBe(false);
  });
});
