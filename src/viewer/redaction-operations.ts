/**
 * Pure function for applying redaction annotations.
 *
 * Extracted from src/viewer/main.ts to mirror the pattern of
 * annotation-operations.ts and form-operations.ts — pure functions that
 * receive the SDK instance and related context as parameters so they can be
 * unit-tested independently of the module-level state in main.ts.
 *
 * IMPORTANT: Do not import node:* — this file is part of the browser bundle.
 */

import type { AutoSaveController } from "./auto-save.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NutrientSDKType = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ViewerInstance = any;

export interface ApplyRedactionsResult {
  ok: true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applied: any[];
}

export interface ApplyRedactionsError {
  error: string;
}

/**
 * Apply pending redaction annotations permanently to the document.
 *
 * 1. Snapshots the redaction annotations BEFORE applying (they are consumed
 *    by `applyRedactions()`).
 * 2. Calls `autoSaveController.flushIfDirty()` to ensure pending mutations
 *    are settled before apply (closes the create→apply race).
 * 3. Calls `instance.applyRedactions()`.
 * 4. Calls `autoSaveController.flushNow()` unconditionally to write the
 *    redacted bytes to disk (the SDK clears dirty bit during the reload;
 *    `flushIfDirty` would no-op without the unconditional variant).
 *
 * Returns a structured result object; throws on unexpected errors.
 */
export async function applyRedactions(
  instance: ViewerInstance,
  autoSaveController: AutoSaveController | null,
  NutrientSDK: NutrientSDKType
): Promise<ApplyRedactionsResult> {
  // Snapshot the redaction annotations BEFORE applying — applyRedactions
  // permanently consumes them, so if the model wants to know what was
  // applied (page index, rect, contents), this is its only chance.
  const RedactionAnnotation = NutrientSDK?.Annotations?.RedactionAnnotation;
  const pageCount = instance.totalPageCount ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applied: any[] = [];
  if (RedactionAnnotation) {
    for (let p = 0; p < pageCount; p++) {
      const anns = await instance.getAnnotations(p);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const a of anns.toArray() as any[]) {
        if (a instanceof RedactionAnnotation && typeof a.toJSON === "function") {
          try {
            applied.push(a.toJSON());
          } catch {
            /* skip un-serializable annotation */
          }
        }
      }
    }
  }

  // Drain any pending mutations before applying. The create path is
  // async and apply will silently redact nothing if the underlying
  // core hasn't seen the annotation yet. `flushIfDirty()` here drives
  // the auto-save loop to settle anything that landed during the
  // create-redactions phase (cancels pending debounce, awaits
  // in-flight, exports if dirty). The `instance.create()` Promise
  // should make this redundant
  // for our flow, but the cost is negligible (no-op when clean) and it
  // closes the create→apply race in the same way the canonical
  // implementation does.
  if (autoSaveController) {
    try {
      await autoSaveController.flushIfDirty();
    } catch {
      /* same swallow rationale as the post-apply flush below */
    }
  }

  await instance.applyRedactions();

  // Drive the redacted bytes to disk before responding. The SDK reloads
  // the document internally as part of applyRedactions and clears the
  // dirty bit during that reload — so `flushIfDirty()` would no-op even
  // though the new (redacted) bytes haven't reached disk. Force an
  // unconditional flush. Apply is the terminal mutation; there's no
  // future event to catch up the lag, and without this the on-disk file
  // is left with redaction annotations but unredacted underlying text.
  if (autoSaveController) {
    try {
      await autoSaveController.flushNow();
    } catch {
      /* errors are routed through the controller's onError; swallow
         here so a transient save failure doesn't mask the apply. */
    }
  }

  return { ok: true, applied };
}
