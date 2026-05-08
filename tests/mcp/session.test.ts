import { describe, it, expect, beforeEach } from "vitest";
import * as sessionModule from "../../src/mcp/session.js";
import { randomUUID } from "node:crypto";

describe("SessionState", () => {
  beforeEach(() => {
    // Reset session state to defaults before each test
    const state = sessionModule.getSession();
    state.viewUUID = randomUUID();
    state.pending = new Map();
    state.documentPath = null;
    sessionModule.setDocumentDirty(false);
    sessionModule.setDocumentCheckpoint(null);
    sessionModule.setIsPendingSave(false);
  });

  describe("initial state", () => {
    it("starts with documentPath=null", () => {
      const state = sessionModule.getSession();
      expect(state.documentPath).toBe(null);
    });
  });

  describe("setOpenDocument", () => {
    it("sets documentPath", () => {
      const testPath = "/mnt/virtiofs/test.pdf";
      sessionModule.setOpenDocument(testPath);

      const state = sessionModule.getSession();
      expect(state.documentPath).toBe(testPath);
    });

    it("overwrites previous documentPath", () => {
      sessionModule.setOpenDocument("/path/one.pdf");
      sessionModule.setOpenDocument("/path/two.pdf");

      const state = sessionModule.getSession();
      expect(state.documentPath).toBe("/path/two.pdf");
    });

    it("resets fs-sync flags so they don't leak across an in-place swap", () => {
      // Simulate the prior path having dirty + a stale checkpoint + a save
      // bracket in flight.
      sessionModule.setOpenDocument("/path/one.pdf");
      sessionModule.setDocumentDirty(true);
      sessionModule.setDocumentCheckpoint({ size: 1024, mtime: 1000 });
      sessionModule.setIsPendingSave(true);

      // In-place swap to a new path.
      sessionModule.setOpenDocument("/path/two.pdf");

      expect(sessionModule.isDocumentDirty()).toBe(false);
      expect(sessionModule.getDocumentCheckpoint()).toBe(null);
      expect(sessionModule.isPendingSave()).toBe(false);
    });

    it("resets fs-sync flags even when re-opening the same path (recovery)", () => {
      sessionModule.setOpenDocument("/path/one.pdf");
      sessionModule.setDocumentDirty(true);
      sessionModule.setDocumentCheckpoint({ size: 1024, mtime: 1000 });

      // Re-open same path — this must clear dirty so the user can recover
      // by re-opening without first calling close_document.
      sessionModule.setOpenDocument("/path/one.pdf");

      expect(sessionModule.isDocumentDirty()).toBe(false);
      expect(sessionModule.getDocumentCheckpoint()).toBe(null);
    });
  });

  describe("hasOpenDocument", () => {
    it("returns true when documentPath is set", () => {
      sessionModule.setOpenDocument("/test.pdf");
      expect(sessionModule.hasOpenDocument()).toBe(true);
    });

    it("returns false when documentPath is null", () => {
      const state = sessionModule.getSession();
      state.documentPath = null;
      expect(sessionModule.hasOpenDocument()).toBe(false);
    });
  });

  describe("clearOpenDocument", () => {
    it("resets documentPath to null", () => {
      sessionModule.setOpenDocument("/test.pdf");

      sessionModule.clearOpenDocument();

      const state = sessionModule.getSession();
      expect(state.documentPath).toBe(null);
    });

    it("does not clear queues or pending", () => {
      const state = sessionModule.getSession();
      sessionModule.enqueue({ type: "get_view_state", requestId: "req-1" });
      state.pending.set("req-1", { resolve: () => {}, reject: () => {} });

      sessionModule.clearOpenDocument();

      // Queue for the active view is preserved across clearOpenDocument.
      expect(sessionModule.drainView(state.viewUUID).length).toBe(1);
      expect(state.pending.size).toBe(1);
    });

    it("resets fs-sync state (dirty, checkpoint, pending-save)", () => {
      sessionModule.setOpenDocument("/test.pdf");
      sessionModule.setDocumentDirty(true);
      sessionModule.setDocumentCheckpoint({ size: 1024, mtime: 1000 });
      sessionModule.setIsPendingSave(true);

      sessionModule.clearOpenDocument();

      expect(sessionModule.isDocumentDirty()).toBe(false);
      expect(sessionModule.getDocumentCheckpoint()).toBe(null);
      expect(sessionModule.isPendingSave()).toBe(false);
    });
  });

  describe("documentDirty", () => {
    it("starts false", () => {
      expect(sessionModule.isDocumentDirty()).toBe(false);
    });

    it("flips to true via setDocumentDirty", () => {
      sessionModule.setDocumentDirty(true);
      expect(sessionModule.isDocumentDirty()).toBe(true);
    });

    it("flips back to false", () => {
      sessionModule.setDocumentDirty(true);
      sessionModule.setDocumentDirty(false);
      expect(sessionModule.isDocumentDirty()).toBe(false);
    });
  });

  describe("documentCheckpoint", () => {
    it("starts null", () => {
      expect(sessionModule.getDocumentCheckpoint()).toBe(null);
    });

    it("round-trips a checkpoint", () => {
      const cp = { size: 4096, mtime: 1700000000000 };
      sessionModule.setDocumentCheckpoint(cp);
      expect(sessionModule.getDocumentCheckpoint()).toEqual(cp);
    });

    it("can be cleared back to null", () => {
      sessionModule.setDocumentCheckpoint({ size: 1, mtime: 2 });
      sessionModule.setDocumentCheckpoint(null);
      expect(sessionModule.getDocumentCheckpoint()).toBe(null);
    });
  });

  describe("isPendingSave", () => {
    it("starts false", () => {
      expect(sessionModule.isPendingSave()).toBe(false);
    });

    it("flips to true and back", () => {
      sessionModule.setIsPendingSave(true);
      expect(sessionModule.isPendingSave()).toBe(true);
      sessionModule.setIsPendingSave(false);
      expect(sessionModule.isPendingSave()).toBe(false);
    });
  });

  describe("getDocumentPath module export", () => {
    it("returns null pre-open", () => {
      expect(sessionModule.getDocumentPath()).toBe(null);
    });

    it("returns the open document path after setOpenDocument", () => {
      sessionModule.setOpenDocument("/foo.pdf");
      expect(sessionModule.getDocumentPath()).toBe("/foo.pdf");
    });
  });
});
