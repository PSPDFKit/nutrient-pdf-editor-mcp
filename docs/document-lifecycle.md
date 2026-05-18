# Document lifecycle: open, close, in-place switch

## TL;DR

**Each `open_document` call generates a fresh `viewUUID`** that binds the
server to exactly one conversation's iframe. When `open_document` is
called from a new conversation, the server first **broadcasts
`close_document`** to any recently-live prior viewUUIDs (waiting up to
`CLOSE_BROADCAST_TIMEOUT_MS`, default 2 s, per prior view, in parallel)
so those iframes render the "Reopen the document to continue" placeholder
and the user sees an explicit recovery message when they switch back to a
prior conversation. The prior conversation's viewer is then effectively
in CLOSED state.

The viewer holds **at most one active document open per conversation**,
and the server tracks at most one currently-active `viewUUID`. Opening a
new document in the **same** conversation while one is already open is
handled **iframe-side via an atomic SDK swap** — the prior document stays
visible the entire time the new one loads, then snaps over. There is no
headless mode, no `show_viewer` step, and no transitional blank state.
`close_document` is idempotent: pre-open it's a no-op; post-open it
auto-flushes any unsaved mutations, tears down the SDK, and explicitly
empties `#viewer` so the static CSS placeholder reappears.

While the document is OPEN, mutations made through MCP tools
auto-persist back to disk via a debounced `saveStateChange` listener
in the iframe (5000 ms after the last edit) — there is no public save
tool. A server-side staleness watcher detects external edits to the
file and flips a dirty flag that causes every subsequent operating
tool to throw `McpError("Document on disk has changed…")`. The remedy
is `close_document` + `open_document`; we do not merge or live-reload.

## State machine

```
                             open_document(P1)
            ┌──────────────────────────────────────┐
            ▼                                      │
    ┌──────────────┐                       ┌───────┴────────┐
    │   CLOSED     │                       │ OPEN (P_curr)  │
    │              │                       │  fresh         │ ◄──── auto-save loop
    │ #viewer is   │   close_document      │  (operating    │       (saveStateChange
    │ empty;       │ ◄──────────────────── │   tools work)  │        → 5000 ms debounce
    │ :empty::before│  (auto-flushes if    │                │        → exportPDF
    │  shows       │   hasUnsavedChanges)  └────┬───────┬───┘        → write_document_bytes
    │ "nutrient"   │                            │       │            → atomic rename;
    └──────────────┘                            │       │              checkpoint refresh)
            ▲                                   │       │
            │                                   │       │ external edit detected by
            │                                   │       │ fs.watch (size+mtime ≠
            │                                   │       │ checkpoint, isPendingSave
            │                                   │       │ false) — flips dirty flag
            │                                   │       ▼
            │                                   │  ┌────────────────┐
            │                                   │  │ OPEN (P_curr)  │
            │                close_document     │  │  stale         │
            └───────────────────────────────────┼──┤                │
                                                │  │ requireFresh-  │
                                                │  │ Document fires │
                                                │  │ on every       │
                                                │  │ operating tool;│
                                                │  │ user must close│
                                                │  │ + reopen       │
                                                │  └────────────────┘
                                                │
                                                │ open_document(P2)
                                                │ where P2 ≠ P_curr
                                                ▼
                                    ┌───────────────────────┐
                                    │ ATOMIC SWAP IN FLIGHT │
                                    │                       │
                                    │ P_curr still rendering│
                                    │ P2 loading in parallel│
                                    │ no transitional blank │
                                    └───────────┬───────────┘
                                                │ load(P2) resolves;
                                                │ unload(P_curr)
                                                ▼
                                    ┌───────────────────────┐
                                    │     OPEN (P2)         │
                                    └───────────────────────┘
```

The CLOSED state is the iframe's resting state — what the user sees
before any tool call, and what they see again after `close_document`.
The `OPEN (stale)` sub-state is invisible to the user (the iframe still
shows the in-memory document); it only manifests as `McpError` on the
next operating-tool call.

**CLOSED via broadcast-close** (multi-conversation sub-state): when a
new conversation calls `open_document`, the server broadcasts
`close_document` to any prior conversation's iframes that polled within
the last 5 s. Those iframes transition to CLOSED on ack — they render
a `.nutrient-viewer-fallback` element with "Reopen the document to
continue" text. The user switching back to a prior conversation sees
this fallback message and knows to re-invoke `open_document`.

## The three operations

### `open_document(path)` from CLOSED

**Server side** (`src/mcp/tools/open-document.ts`):
1. `validatePathInAllowedRoots(path)` — fails fast against MCP roots.
2. `existsSync` defensive check.
3. Generate `newViewUUID = randomUUID()` — a fresh identifier that
   binds this conversation's iframe to the server's command queue.
4. **Broadcast-close**: for each viewUUID that polled within the last
   5 s (excluding `newViewUUID`), enqueue `{type:"close_document"}`
   and await ack (up to `CLOSE_BROADCAST_TIMEOUT_MS`, default 2 s).
   Runs all targets in parallel via `Promise.allSettled`. Proceeds
   regardless of ack success — a timed-out prior iframe is treated
   as gone.
5. `stopWatching()` + `clearOpenDocument()` — clean up the prior
   open's watcher and dirty flags before mutating to the new one.
6. `setActiveViewUUID(newViewUUID)` + `setOpenDocument(abs)` — updates
   the active view binding and session `STATE.documentPath`, resetting
   FS-sync flags.
7. `startWatching(abs)` — re-snapshots `documentCheckpoint` (always,
   even on same-path re-open) and starts/replaces the `fs.watch`.
8. Returns `{ documentPath: abs, viewUUID: newViewUUID }` in
   `structuredContent` and `_meta`. **Does not enqueue any viewer command.**

**Iframe side** (`src/viewer/main.ts`):
1. `ontoolresult` handler reads `structuredContent.documentPath`.
2. Notices `nextPath !== currentDocumentPath` (the latter is `null` when
   CLOSED) and calls `openDocumentFromPath(nextPath)`.
3. `fetchDocumentBytes()` → one `app.readServerResource({ uri: "nutrient-doc:///current" })` call; the resource returns the file as a single base64 `blob`.
4. `NutrientSDK.load({ container: viewerEl, document: bytes, baseUrl })`
   — full UI mounted directly, no headless step.
5. `currentDocumentPath = nextPath`; `instance = next`.

### `open_document(path2)` while already OPEN with `path1`

The model calls the tool again with a different path. The server is
oblivious to whether anything was already open — it just runs the same
flow as above and returns. The interesting part is on the iframe.

**Server side:** identical to the CLOSED → OPEN flow. There is **no
"close the prior document first" command** enqueued; the server's only
record is `STATE.documentPath` getting overwritten.

**Iframe side** (`openDocumentFromPath` in `src/viewer/main.ts`):
1. `instance` is non-null (prior load).
2. `fetchDocumentBytes(nextPath)` for the new bytes.
3. **Atomic swap:**
   ```ts
   const next = await NutrientSDK.load({...});  // load INTO MEMORY
   const priorInstance = instance;
   instance = next;                              // switch refs
   currentDocumentPath = nextPath;
   if (priorInstance) NutrientSDK.unload(priorInstance);  // tear down old
   ```
4. The user keeps seeing the prior document the entire time `load(next)`
   is in flight — typically 0.5–3 s for a real PDF. When the swap lands,
   the new document is fully painted; there's no flash, no blank, no
   placeholder.

This is why we don't enqueue a transitional `close_document` command:
it would force the iframe through CLOSED (placeholder visible) before
reaching the new OPEN state, which is jarring.

#### In-flight save during in-place SDK swap

If the prior controller had a save in flight (or in its debounce window)
when the swap began, the controller's `dispose()` detaches the listener
and cancels the pending debounce — but it does **not** cancel the
in-flight `runFlush()` (by design; see `auto-save.ts:19-21`). That save
continues to completion on the prior instance's exported bytes.

The server's `setOpenDocument(path2)` overwrites session state
synchronously inside the tool handler — long before the iframe even
sees the result. So by the time the prior controller's chunks reach
`write_document_bytes`, `getDocumentPath()` already returns `path2`.
Without protection, those bytes (which represent `path1`'s content)
would be staged at `${path2}.${viewUUID}.tmp` and atomic-renamed over
`path2`, **silently corrupting the freshly-opened document**.

The protection is **stream-binding**: each chunk carries the
`documentPath` the auto-save controller captured at setup time
(`AutoSaveOptions.documentPath`, threaded through
`streamBytesToServer`). The server compares it to `getDocumentPath()`
and rejects any chunk where the two diverge, also unlinking the prior
path's staging file so it doesn't accumulate. The prior document's
pending edits are dropped — this is preferable to corrupting the new
document. There is no "pre-swap flush": doing so would either delay
the swap until export+upload completes (defeating the no-flicker
property) or require an iframe→server handshake that the current "open
doesn't enqueue" design doesn't support.

User implication: rapidly switching documents while edits are pending
can lose the prior document's last edits. Models should call
`close_document` before opening a different document if they want a
guaranteed flush — `close_document` runs `flushIfDirty()` before
teardown.

### `close_document()` from OPEN

**Server side** (`src/mcp/tools/close-document.ts`):
1. If `!hasOpenDocument()`: return `{ closed: true }` immediately. No
   viewer command enqueued. **Idempotent.**
2. Otherwise: enqueue `{ type: "close_document", requestId }`,
   `Promise.race` against `VIEWER_TIMEOUT_MS`.
3. On ack: `stopWatching()` (closes the staleness watcher),
   `clearOpenDocument()` (resets `documentPath`, `documentDirty`,
   `documentCheckpoint`, `isPendingSave`), return `{ closed: true }`.

**Iframe side** (`closeDocument` in `src/viewer/main.ts`):
1. `autoSaveController.flushIfDirty()` if a controller is installed —
   cancels any pending debounce, awaits any in-flight save, and runs
   one final flush if `instance.hasUnsavedChanges()` is still true.
   This is the close-time guarantee that no work is silently dropped
   on teardown (spec D8).
2. `autoSaveController.dispose()`; controller reset to null.
3. `NutrientSDK.unload(instance)`.
4. `instance = null`, `currentDocumentPath = null`.
5. **Explicitly** `viewerEl.replaceChildren()` — defensive emptying so
   the CSS `#viewer:empty::before` selector matches reliably and the
   placeholder reappears.
6. `submit_response(requestId, { closed: true })`.

`close_document` is the only operating tool that does **not** call
`requireFreshDocument()` — closing a stale document is a valid
recovery path, and the close-time flush is best-effort (the
in-flight save would still run pre-rename stat-compare and abort if
the file diverged).

### `close_document()` pre-open (no document ever opened or already closed)

Returns `{ closed: true }` synchronously without touching the queue.
This makes redundant close calls cheap — model code can call it as a
safety measure without worrying about timing.

## Why these design choices

### Why no headless mode

An earlier design had a "headless / loaded-but-hidden" intermediate
state with a separate `show_viewer` tool. Removed because:

- Two operating states means two failure surfaces; one well-defined
  state is simpler.
- Models don't reliably interleave `show_viewer` correctly — they'd
  either forget it (silent failure: tools work but nothing visible) or
  call it redundantly.
- Cowork renders the iframe immediately when the tool result carries a
  `resourceUri`; trying to "stay hidden" was fighting the host.

The current invariant is: **tool result with `resourceUri` ⇒ iframe is
visible ⇒ document is loading or loaded.** No third state.

### Why iframe-side atomic swap (not server-side close-then-open)

The naive design would be: when `open_document` is called while another
is open, the server enqueues `close_document` for the iframe, waits for
ack, then enqueues `open_document`. That makes the server's state
machine simple and explicit. We rejected it because:

- The user sees a CLOSED → OPEN flicker between documents — placeholder
  flashes for ~half a second. Bad demo experience.
- Two round-trips through the long-poll bridge instead of zero
  (open_document doesn't enqueue at all in the current design).
- The SDK supports atomic swap natively (`load` returns a fresh
  instance; `unload` tears down a separate one), so we'd be doing extra
  work to forfeit a feature the SDK gives us for free.

The current design pushes the swap entirely into `openDocumentFromPath`
in the viewer. The server is stateless about transitions.

### Why the placeholder is CSS-only

The pre-mount visual ("nutrient" wordmark + "Loading…" subtitle, faint
pulse animation) is a single CSS rule on `#viewer:empty::before` and
`::after`. No JS toggles its visibility — it's purely declarative,
matching whenever `#viewer` has no children. The viewer code only has
to ensure that `#viewer` IS empty (after close) or non-empty (when SDK
is mounted) for the right state to display.

This was a deliberate change from an earlier design with a separate
`#status` div whose `style.display` was JS-toggled. The toggle had race
conditions during cold open (the static placeholder text leaked through
during SDK import + byte fetch) and added two DOM-mutation paths to
keep in sync. CSS-only is one path.

### Why `close_document` explicitly empties `#viewer` after `unload`

`NutrientSDK.unload(instance)` typically clears its own children, but
relying on that to make `:empty` match is fragile — a future SDK
version could leave a `<div>` behind and the placeholder would never
reappear. `viewerEl.replaceChildren()` is a one-line guarantee that
`:empty` matches.

## Auto-save and freshness

The OPEN state has two orthogonal concerns layered on top of "the SDK
is mounted":

- **Auto-save loop** (iframe side, `src/viewer/auto-save.ts`):
  subscribes to `instance.addEventListener("document.saveStateChange", …)`
  at SDK-load time. On `hasUnsavedChanges: true`, debounces 5000 ms,
  then `instance.exportPDF()` → `streamBytesToServer` → atomic rename
  via `write_document_bytes`. Drop-in-flight semantics: events arriving
  while a save is running are dropped. Terminal operations drive an
  explicit flush to catch work that would otherwise be lost: close-time
  uses `flushIfDirty()` (gated on `hasUnsavedChanges()`); apply-time
  uses `flushNow()` (unconditional, because `applyRedactions` reloads
  the document internally and clears the SDK's dirty bit before our
  flush runs).
- **Staleness watcher** (server side, `src/mcp/staleness-watcher.ts`):
  `fs.watch` on the open document. Its listener consults
  `isPendingSave()` (set by `write_document_bytes` around its rename)
  for self-write suppression, then re-stats the file and compares to
  the checkpoint snapshotted at open-time. A real divergence flips
  `documentDirty=true` and stops the watcher; the freshness guard
  catches the dirty flag on the next operating-tool call.

Three layers protect against silent clobbering of an external edit:

1. The watcher flips dirty on `fs.watch` events that show real
   `size + mtime` divergence; the freshness guard rejects subsequent
   operating tools (including `write_document_bytes` chunks).
2. The pre-rename stat-compare in `write_document_bytes` (spec D11)
   re-stats the destination immediately before `fs.renameSync` and
   aborts if the checkpoint diverges. Closes the watcher self-edit
   suppression race window.
3. After a successful save, the checkpoint is refreshed to the
   just-saved `size + mtime` so subsequent saves don't trip D11
   against our own prior write.

The staleness flow is invisible to the user (the iframe still shows
the in-memory document) — it only manifests as `McpError(InvalidParams,
"Document on disk has changed since it was opened…")` on the next
operating-tool call. The remedy is `close_document` + `open_document`;
there is no merge path and no live reload.

## Code map

### Server side
| File | Responsibility |
|---|---|
| [`src/mcp/tools/open-document.ts`](../src/mcp/tools/open-document.ts) | Validate path, set session state, start the staleness watcher, return `{documentPath, viewUUID}` (no enqueue) |
| [`src/mcp/tools/close-document.ts`](../src/mcp/tools/close-document.ts) | Idempotent pre-open; post-open enqueue + race + `stopWatching()` + clear session state |
| [`src/mcp/tools/write-document-bytes.ts`](../src/mcp/tools/write-document-bytes.ts) | Internal viewer-only chunked write tool. Refuses on stale via `requireFreshDocument`; pre-rename stat-compare (D11); brackets the rename with `setIsPendingSave(true) … +500 ms → false`; refreshes the checkpoint after rename |
| [`src/mcp/staleness-watcher.ts`](../src/mcp/staleness-watcher.ts) | `startWatching` / `stopWatching` — native `fs.watch` with size+mtime comparison and self-write suppression |
| [`src/mcp/session.ts`](../src/mcp/session.ts) | `setOpenDocument` / `clearOpenDocument` / `hasOpenDocument`, plus the fs-sync flags (`documentDirty`, `documentCheckpoint`, `isPendingSave`) |
| [`src/mcp/document-guard.ts`](../src/mcp/document-guard.ts) | `requireOpenDocument()` and `requireFreshDocument()` — every operating tool calls both as its first two statements |

### Iframe side
| File | Responsibility |
|---|---|
| [`src/viewer/main.ts`](../src/viewer/main.ts) | `openDocumentFromPath` (with atomic swap and auto-save controller install), `closeDocument` (with `flushIfDirty` + dispose), `instance` / `currentDocumentPath` / `autoSaveController` module state |
| [`src/viewer/auto-save.ts`](../src/viewer/auto-save.ts) | `setupAutoSaveOnInstance(instance, { sink, debounceMs }) → AutoSaveController`. `saveStateChange` listener with debounce + drop-in-flight; `flushIfDirty()` for close-time, `flushNow()` for apply-time (unconditional — bypasses the dirty bit applyRedactions clears as part of its internal reload) |
| [`src/viewer/document-save.ts`](../src/viewer/document-save.ts) | `streamBytesToServer(bytes, sink)` — chunks an exported PDF into ≤512 KiB base64 calls to `write_document_bytes`, in order, finalizing on the last chunk |
| [`src/viewer/index.html`](../src/viewer/index.html) | The `#viewer` div + the `:empty::before/::after` placeholder rules |

## Invariants worth re-stating

- The iframe's `#viewer` has children **iff** the SDK is mounted.
- `instance == null` **iff** `currentDocumentPath == null`.
- `open_document` never enqueues a viewer command. Every other operating
  tool does.
- `close_document` enqueues exactly when `hasOpenDocument()` is true.
- A new `open_document` while another is open replaces the prior one
  without ever passing through CLOSED.
- The staleness watcher is active **iff** `hasOpenDocument()` is true.
  `startWatching` is called from `open_document`; `stopWatching` from
  `close_document`. Both are idempotent.
- `documentDirty` is reset by both `clearOpenDocument()` (i.e.
  `close_document`) and `setOpenDocument()` (i.e. `open_document` and
  the in-place SDK swap path). Re-opening a document — same path or
  different — starts a fresh staleness checkpoint, so a stale dirty
  flag set against the prior path cannot reject operating tools
  against the newly-loaded document.
- `write_document_bytes` always refreshes the checkpoint on success, so
  subsequent saves cannot trip D11 against our own prior write.
- The auto-save loop and the staleness watcher are independent: the
  iframe drives auto-save, the server runs the watcher; they
  communicate exclusively through the `documentDirty` /
  `documentCheckpoint` / `isPendingSave` flags on `SessionBackend`.
