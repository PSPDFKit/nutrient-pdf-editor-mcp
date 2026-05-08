import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupAutoSaveOnInstance } from "../../src/viewer/auto-save.js";
import { makeInstance, makeSink } from "../helpers/auto-save-fakes.js";

const DOC_PATH = "/mnt/virtiofs/test.pdf";

describe("setupAutoSaveOnInstance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("default debounce is wide enough to coalesce model-rate mutations (4s gap)", async () => {
    // Demo flows fire one create_annotation every 2-3s. With a short default
    // debounce, each create triggers its own exportPDF — visible UI lock per
    // mutation. The default must therefore be wider than typical model rate
    // so a series of mutations coalesces into a single save.
    const inst = makeInstance();
    const sinkSpy = makeSink();
    // Intentionally omit debounceMs to exercise the production default.
    setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, documentPath: DOC_PATH });

    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(4000);
    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(4000);
    inst.fire({ hasUnsavedChanges: true });

    // Three events at 4-second intervals — with the prior 1500ms default
    // every gap would have flushed a separate save. With the bumped default
    // (≥5000ms), the timer keeps resetting and only the final settle
    // produces a flush.
    expect(inst.exportPDFCalls()).toBe(0);

    // Settle past the new debounce window since the LAST event.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(inst.exportPDFCalls()).toBe(1);
  });

  it("attaches a listener at setup and detaches on dispose", () => {
    const inst = makeInstance();
    const { sink } = makeSink();
    expect(inst.listenerCount()).toBe(0);
    const ctrl = setupAutoSaveOnInstance(inst, { sink, documentPath: DOC_PATH });
    expect(inst.listenerCount()).toBe(1);
    ctrl.dispose();
    expect(inst.listenerCount()).toBe(0);
  });

  it("ignores events with hasUnsavedChanges=false", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, debounceMs: 1500, documentPath: DOC_PATH });
    inst.fire({ hasUnsavedChanges: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(inst.exportPDFCalls()).toBe(0);
    expect(sinkSpy.callCount()).toBe(0);
  });

  it("triggers a save once after the debounce window", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, debounceMs: 1500, documentPath: DOC_PATH });
    inst.fire({ hasUnsavedChanges: true });
    expect(inst.exportPDFCalls()).toBe(0); // not yet
    await vi.advanceTimersByTimeAsync(1500);
    // microtasks for exportPDF + streamBytesToServer
    await vi.advanceTimersByTimeAsync(0);
    expect(inst.exportPDFCalls()).toBe(1);
    expect(sinkSpy.callCount()).toBeGreaterThanOrEqual(1);
  });

  it("debounces: rapid events within the window coalesce to a single save", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, debounceMs: 1500, documentPath: DOC_PATH });
    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(500);
    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(500);
    inst.fire({ hasUnsavedChanges: true });
    // total elapsed = 1000; no save yet
    expect(inst.exportPDFCalls()).toBe(0);
    // advance past full debounce window since the LAST event
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(0);
    expect(inst.exportPDFCalls()).toBe(1);
  });

  it("drops events that fire while a save is in flight", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    inst.setExportPDFDelay(200); // makes the in-flight window observable
    setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, debounceMs: 1500, documentPath: DOC_PATH });

    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(1500);
    // Save started; exportPDF is mid-flight (200ms delay).
    expect(inst.exportPDFCalls()).toBe(1);

    // Fire another event while still in flight
    inst.fire({ hasUnsavedChanges: true });
    // Even after a full debounce window, no second save runs because the
    // event was dropped (no timer was scheduled).
    await vi.advanceTimersByTimeAsync(2000);
    expect(inst.exportPDFCalls()).toBe(1);
  });

  it("flushIfDirty cancels pending debounce, awaits in-flight, and final-flushes if still dirty", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    inst.setExportPDFDelay(50);
    const ctrl = setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 1500,
      documentPath: DOC_PATH
    });

    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(1500);
    // First save now in flight
    expect(inst.exportPDFCalls()).toBe(1);

    // A mutation lands during the in-flight save; it would be dropped by
    // the listener, but the SDK still reports unsaved at flushIfDirty time.
    inst.setUnsaved(true);

    const flushPromise = ctrl.flushIfDirty();
    await vi.advanceTimersByTimeAsync(50); // first save completes
    await vi.advanceTimersByTimeAsync(50); // second (final) save completes
    await flushPromise;

    expect(inst.exportPDFCalls()).toBe(2);
  });

  it("flushIfDirty is a no-op when nothing is pending and the SDK is clean", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    const ctrl = setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, documentPath: DOC_PATH });
    await ctrl.flushIfDirty();
    expect(inst.exportPDFCalls()).toBe(0);
    expect(sinkSpy.callCount()).toBe(0);
  });

  it("flushNow flushes unconditionally even when the SDK reports clean", async () => {
    // applyRedactions reloads the document internally and clears the dirty
    // flag, so flushIfDirty would no-op. flushNow must export anyway —
    // otherwise the redacted bytes never reach disk.
    const inst = makeInstance();
    const sinkSpy = makeSink();
    const ctrl = setupAutoSaveOnInstance(inst, { sink: sinkSpy.sink, documentPath: DOC_PATH });
    expect(inst.hasUnsavedChanges()).toBe(false);

    await ctrl.flushNow();

    expect(inst.exportPDFCalls()).toBe(1);
    expect(sinkSpy.callCount()).toBeGreaterThanOrEqual(1);
  });

  it("flushNow cancels a pending debounce so it does not double-fire", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    const ctrl = setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 1500,
      documentPath: DOC_PATH
    });

    inst.fire({ hasUnsavedChanges: true });
    // Don't advance to debounce expiry — flushNow should pre-empt it.
    await ctrl.flushNow();
    expect(inst.exportPDFCalls()).toBe(1);

    // Originally-scheduled debounce was cancelled.
    await vi.advanceTimersByTimeAsync(2000);
    expect(inst.exportPDFCalls()).toBe(1);
  });

  it("flushNow awaits an in-flight save before its forced flush", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    inst.setExportPDFDelay(50);
    const ctrl = setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 1500,
      documentPath: DOC_PATH
    });

    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(1500);
    // First save in flight (50ms exportPDF delay)
    expect(inst.exportPDFCalls()).toBe(1);

    const flushPromise = ctrl.flushNow();
    await vi.advanceTimersByTimeAsync(50); // first save completes
    await vi.advanceTimersByTimeAsync(50); // forced flush completes
    await flushPromise;

    expect(inst.exportPDFCalls()).toBe(2);
  });

  it("flushIfDirty cancels a pending debounce timer (no double save)", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    const ctrl = setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 1500,
      documentPath: DOC_PATH
    });

    inst.fire({ hasUnsavedChanges: true });
    // Don't advance to debounce expiry — instead flush immediately.
    inst.setUnsaved(true);
    await ctrl.flushIfDirty();
    expect(inst.exportPDFCalls()).toBe(1);

    // The originally-scheduled debounce should have been cancelled.
    inst.setUnsaved(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(inst.exportPDFCalls()).toBe(1);
  });

  it("dispose cancels a pending debounce so the save never runs", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    const ctrl = setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 1500,
      documentPath: DOC_PATH
    });

    inst.fire({ hasUnsavedChanges: true });
    ctrl.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(inst.exportPDFCalls()).toBe(0);
    expect(sinkSpy.callCount()).toBe(0);
  });

  it("survives exportPDF errors via onError; the listener stays live", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    const errors: unknown[] = [];
    setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 100,
      onError: (e) => errors.push(e),
      documentPath: DOC_PATH
    });

    // Force exportPDF to throw on the first call only; subsequent calls go
    // back to the (successful) original implementation.
    let firstCall = true;
    const origExportPDF = inst.exportPDF.bind(inst);
    inst.exportPDF = async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error("export blew up");
      }
      return origExportPDF();
    };

    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("export blew up");
    // The first save threw before reaching the sink.
    expect(sinkSpy.callCount()).toBe(0);

    // A subsequent event must still produce a successful save — proves the
    // listener and the controller's in-flight bookkeeping recovered cleanly.
    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(sinkSpy.callCount()).toBeGreaterThanOrEqual(1);
  });

  it("supports being torn down and re-installed (in-place SDK swap pattern)", async () => {
    // Simulate the in-place SDK swap: dispose old controller, install new
    // one on a fresh instance. Verify no event leakage between them.
    const oldInst = makeInstance();
    const newInst = makeInstance();
    const sinkSpy = makeSink();

    const oldCtrl = setupAutoSaveOnInstance(oldInst, {
      sink: sinkSpy.sink,
      debounceMs: 100,
      documentPath: "/old.pdf"
    });
    oldCtrl.dispose();
    expect(oldInst.listenerCount()).toBe(0);

    const newCtrl = setupAutoSaveOnInstance(newInst, {
      sink: sinkSpy.sink,
      debounceMs: 100,
      documentPath: "/new.pdf"
    });
    expect(newInst.listenerCount()).toBe(1);

    // Old listener is gone — firing on the old instance is a no-op
    oldInst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(oldInst.exportPDFCalls()).toBe(0);

    // New listener is live
    newInst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);
    expect(newInst.exportPDFCalls()).toBe(1);

    newCtrl.dispose();
  });

  it("threads its captured documentPath onto every chunk it streams", async () => {
    const inst = makeInstance();
    const sinkSpy = makeSink();
    setupAutoSaveOnInstance(inst, {
      sink: sinkSpy.sink,
      debounceMs: 100,
      documentPath: "/captured/at-setup.pdf"
    });

    inst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    const chunkCalls = sinkSpy.calls().filter((c) => c.name === "write_document_bytes");
    expect(chunkCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of chunkCalls) {
      // The path is captured at controller setup, not re-read per-flush —
      // so an in-place SDK swap that installs a new controller on a
      // different path leaves this stream's chunks tagged with the
      // ORIGINAL path (which the server's stream-binding guard then
      // rejects, dropping the prior document's edits cleanly instead of
      // letting them clobber the new file).
      expect(call.arguments.documentPath).toBe("/captured/at-setup.pdf");
    }
  });

  it("each controller streams its own path even when their saves overlap (in-place swap mid-flight)", async () => {
    // Verifies the load-bearing invariant: documentPath is captured at setup
    // time, so two simultaneously-live controllers (the prior one finishing
    // its in-flight save while the new one was just installed) stay
    // independently bound to the right paths.
    const oldInst = makeInstance();
    const newInst = makeInstance();
    oldInst.setExportPDFDelay(50);
    const sinkSpy = makeSink();

    const oldCtrl = setupAutoSaveOnInstance(oldInst, {
      sink: sinkSpy.sink,
      debounceMs: 100,
      documentPath: "/prior.pdf"
    });

    // Kick off the old controller's save; let it begin but stay in flight.
    oldInst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(100);

    // Mid-flight, install a new controller bound to a different path.
    const newCtrl = setupAutoSaveOnInstance(newInst, {
      sink: sinkSpy.sink,
      debounceMs: 100,
      documentPath: "/replacement.pdf"
    });
    oldCtrl.dispose(); // detaches listener; in-flight save NOT cancelled

    // Drive both saves to completion.
    newInst.fire({ hasUnsavedChanges: true });
    await vi.advanceTimersByTimeAsync(50); // old save finishes its 50ms exportPDF
    await vi.advanceTimersByTimeAsync(100); // new save's debounce
    await vi.advanceTimersByTimeAsync(0);

    const calls = sinkSpy.calls().filter((c) => c.name === "write_document_bytes");
    const priorChunks = calls.filter((c) => c.arguments.documentPath === "/prior.pdf");
    const replacementChunks = calls.filter((c) => c.arguments.documentPath === "/replacement.pdf");
    expect(priorChunks.length).toBeGreaterThanOrEqual(1);
    expect(replacementChunks.length).toBeGreaterThanOrEqual(1);
    // No bleed across paths.
    expect(priorChunks.length + replacementChunks.length).toBe(calls.length);

    newCtrl.dispose();
  });
});
