# Auto-save loop

Last verified: 2026-05-04

Describes the debounced auto-save loop attached to each SDK instance, the terminal-flush list, the distinction between `flushIfDirty` and `flushNow`, and why `applyRedactions` requires an unconditional flush.

The open / close / in-place-switch state machine is in
[`document-lifecycle.md`](document-lifecycle.md); this doc covers only
the auto-save loop attached on top of it.

## How the loop works

After `NutrientSDK.load`, `setupAutoSaveOnInstance` (`auto-save.ts`)
attaches a `document.saveStateChange` listener to the new instance
and binds it to `streamBytesToServer` (`document-save.ts`). On each
event with `hasUnsavedChanges: true` it debounces (5000 ms) and then
exports the document with `instance.exportPDF()` (no flags —
Nutrient's idiomatic full save) and streams the bytes back to the
server's `write_document_bytes` internal tool. Events arriving while
a save is in flight are dropped — the file may briefly lag the
in-memory state until either a later `saveStateChange` fires or a
terminal operation drives an explicit flush.

The debounce is intentionally wide enough that a typical model-driven
mutation sequence (one tool call every 2-3 s) coalesces into a single
flush at the end. `exportPDF` is heavy main-thread work in the SDK,
so per-mutation flushes show up as visible UI locks in the viewer
iframe; the wide debounce keeps that cost off the critical path.

## Terminal-flush list

Terminal operations call an explicit flush so no edits are lost
despite the wide debounce window:

- `closeDocument` runs `flushIfDirty()` before tearing down the SDK
  instance (spec D8). The in-place SDK swap path (re-`open_document`)
  installs a fresh controller on the new instance and disposes the
  old one.
- `applyRedactionsNow` runs `flushNow()` immediately after
  `applyRedactions()` burns the redactions into the document. The
  flush must be unconditional because `applyRedactions` reloads the
  document internally and clears the SDK's dirty bit as part of that
  reload — `flushIfDirty()` would no-op even though the new
  (redacted) bytes still need to reach disk, leaving the on-disk
  file with redaction annotations marked but underlying text intact.

## `flushIfDirty` vs `flushNow`

- `flushIfDirty()` — checks the SDK dirty bit before exporting; safe
  to call on clean documents. Used by `closeDocument`.
- `flushNow()` — exports unconditionally, bypassing the dirty-bit
  check. Required by `applyRedactionsNow` because `applyRedactions`
  reloads the document and clears the dirty bit before the bytes have
  been written to disk.
