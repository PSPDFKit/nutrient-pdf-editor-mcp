/**
 * Auto-save loop driven by Nutrient SDK's `document.saveStateChange` event.
 * Pure module — no DOM, no globals — so the controller can be swapped on
 * in-place SDK loads and unit-tested without an iframe.
 *
 * Behaviour follows the agreed spec (`docs/spec.md` D2-D4, D8):
 *
 *   1. On `saveStateChange { hasUnsavedChanges: true }` schedule a flush
 *      after `debounceMs` (default 5000). Subsequent events within the
 *      window restart the timer (standard debounce). The default is wide
 *      enough that a model-driven sequence of mutations (one tool call
 *      every ~2-3s) coalesces into a single flush at the end, instead of
 *      a separate `exportPDF` per mutation — `exportPDF` is main-thread
 *      heavy in the SDK, and per-mutation flushes show up as visible UI
 *      locks in the viewer iframe. Terminal operations that must reach
 *      disk before returning drive an explicit flush — `close_document`
 *      uses `flushIfDirty()`, `apply_redactions_now` uses `flushNow()`.
 *   2. While a flush is in flight, further events are dropped — they do
 *      not reset the timer and do not queue a follow-up. Mutations that
 *      land during the flush will only reach disk if a subsequent event
 *      fires later, OR if `flushIfDirty()` / `flushNow()` is called.
 *   3. `flushIfDirty()` cancels any pending debounce, awaits any in-flight
 *      flush, then performs one final synchronous flush if the SDK still
 *      reports `hasUnsavedChanges()`. Used by close_document so unsaved
 *      mutations cannot be silently lost on teardown.
 *   4. `flushNow()` is the same as `flushIfDirty` minus the dirty gate —
 *      it always runs the final flush. Used by `apply_redactions_now`
 *      because `applyRedactions` reloads the document internally and
 *      clears the SDK's dirty bit before our flush runs; without the
 *      unconditional flush the redacted bytes never reach disk.
 *   5. `dispose()` detaches the listener and cancels the pending timer.
 *      It deliberately does NOT cancel an in-flight flush — callers that
 *      need the bytes to land must `await flushIfDirty()` (or
 *      `flushNow()`) first.
 */

import { streamBytesToServer, type ChunkedWriteSink } from "./document-save.js";

export interface NutrientInstanceLike {
  addEventListener(
    eventName: "document.saveStateChange",
    handler: (event: { hasUnsavedChanges: boolean }) => void
  ): void;
  removeEventListener(
    eventName: "document.saveStateChange",
    handler: (event: { hasUnsavedChanges: boolean }) => void
  ): void;
  hasUnsavedChanges(): boolean;
  exportPDF(): Promise<ArrayBuffer>;
}

export interface AutoSaveOptions {
  sink: ChunkedWriteSink;
  /**
   * The path the controller claims for every chunked save it streams.
   * Captured at setup time (not re-read per-flush) so an in-place SDK
   * swap installs a fresh controller bound to the new path while the
   * prior controller's in-flight save still targets its original path —
   * the server-side stream-binding guard then rejects the prior stream
   * cleanly instead of letting it write into the new file.
   */
  documentPath: string;
  debounceMs?: number;
  onError?: (err: unknown) => void;
}

export interface AutoSaveController {
  /** Detach the listener and cancel any pending debounce. Does not cancel in-flight saves. */
  dispose(): void;
  /** Await any in-flight save, then flush once more if the SDK is still dirty. */
  flushIfDirty(): Promise<void>;
  /**
   * Cancel pending debounce, await any in-flight save, then run one final
   * flush UNCONDITIONALLY — regardless of `hasUnsavedChanges()`. Use after
   * operations that mutate the document but reset the SDK's dirty flag as a
   * side effect (e.g. `applyRedactions` reloads the document internally and
   * clears the dirty bit, even though the new bytes still need to reach
   * disk). Caller asserts there is real work to persist.
   */
  flushNow(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 5000;

export function setupAutoSaveOnInstance(
  instance: NutrientInstanceLike,
  opts: AutoSaveOptions
): AutoSaveController {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const sink = opts.sink;
  const documentPath = opts.documentPath;
  const onError = opts.onError ?? defaultOnError;

  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  function scheduleFlush(): void {
    if (disposed) return;
    if (inFlight !== null) return; // drop-in-flight: see file header §2
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void runFlush();
    }, debounceMs);
  }

  function runFlush(): Promise<void> {
    const p = (async () => {
      try {
        const bytes = await instance.exportPDF();
        await streamBytesToServer(bytes, sink, documentPath);
      } catch (err) {
        onError(err);
      }
    })().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  }

  function listener(event: { hasUnsavedChanges: boolean }): void {
    if (!event.hasUnsavedChanges) return;
    scheduleFlush();
  }

  instance.addEventListener("document.saveStateChange", listener);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        instance.removeEventListener("document.saveStateChange", listener);
      } catch {
        /* ignore — instance may already be torn down */
      }
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    },
    async flushIfDirty(): Promise<void> {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (inFlight !== null) {
        await inFlight;
      }
      if (instance.hasUnsavedChanges()) {
        await runFlush();
      }
    },
    async flushNow(): Promise<void> {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (inFlight !== null) {
        await inFlight;
      }
      await runFlush();
    }
  };
}

function defaultOnError(err: unknown): void {
  console.error("[nutrient-viewer] auto-save failed:", err);
}
