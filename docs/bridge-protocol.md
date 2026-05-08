# Server ↔ iframe bridge protocol

Last verified: 2026-05-07

## TL;DR

The Node server and the browser iframe don't share a TCP socket or a
WebSocket. They cooperate over a **request-queue + long-poll bridge**
built out of two MCP tools:

- **`poll_commands(viewUUID)`** — viewer drains pending server→viewer
  commands. Long-polls.
- **`submit_response(requestId, data, error?)`** — viewer resolves the
  server-side pending Promise for a previously enqueued command.

When a model invokes a tool like `search_exact_text`, the
server registers a pending Promise, enqueues a `ViewerCommand`, races
against `VIEWER_TIMEOUT_MS`, and waits. The viewer's polling loop picks
up the command, runs the SDK call, and submits the result. The server's
Promise resolves; the tool result returns to the model.

`open_document` is the lone exception — it returns to the model after
a **broadcast-close** to any recently-live prior viewers (up to
`CLOSE_BROADCAST_TIMEOUT_MS`, default 2 s), then returns with the
validated path in `structuredContent`. The iframe picks the path up via
`ontoolresult` and loads the document on its own by reading the MCP
resource `nutrient-doc:///current` via `app.readServerResource` (one
round-trip, single base64 `blob`). See "open_document is special-cased"
below for the full flow including the broadcast-close step.

## Participants

```
        ┌──────────┐  MCP stdio   ┌──────────────┐  ext-apps   ┌──────────────┐
        │  Claude  │ ──────────▶  │  Node server │ ◀────────▶  │ iframe / SDK │
        │  (host)  │              │ (one process │ PostMessage │  (browser)   │
        │          │  ◀────────── │  per stdio   │             │              │
        └──────────┘              │  client)     │             └──────┬───────┘
                                  └──────┬───────┘                    │
                                         │                            │
                                         │  shared session state:     │
                                         │  viewUUID, queue, pending  │
                                         ▼                            │
                                  ┌──────────────┐                    │
                                  │ session.ts   │ ◀──── poll_commands┘
                                  │ STATE        │ ──── ViewerCommand[]┐
                                  │              │                     │
                                  │              │ ◀── submit_response ┘
                                  └──────────────┘
```

The Node server has two MCP-client connections in agent mode, but at
this layer we describe one server process binding one set of tools to
one session.

## Session state

`src/mcp/session.ts` maintains a module singleton:

```ts
const STATE = {
  viewUUID: "<current active viewUUID>",  // set on each open_document call
  documentPath: null as string | null,
};
// Per-view command queues and liveness tracker:
const queues = new Map<string, ViewerCommand[]>();
const liveViews = new Map<string, number>(); // viewUUID → last-poll timestamp
const pending = new Map<string, Pending>();  // requestId → {resolve, reject}
```

- **`viewUUID`** is generated fresh on **each `open_document` call** via
  `randomUUID()` and represents the currently-active conversation's
  iframe. The viewer reads it from `ontoolresult._meta.viewUUID` on the
  first tool result it sees (typically the `open_document` result) and
  uses it on every subsequent `poll_commands` call.
- **`queues`** is a `Map<viewUUID, ViewerCommand[]>` — per-view FIFO
  queues. Commands are enqueued to the active view; the broadcast-close
  path enqueues directly to specific prior-view queues.
- **`liveViews`** is a `Map<viewUUID, timestamp>` — updated on each
  `poll_commands` call to let `getLiveViewUUIDs(staleAfterMs)` find
  iframes that polled recently enough to be worth broadcasting to.
- **`pending`** is a `Map` from `requestId` → resolver pair, populated
  before enqueue and torn down on `submit_response`.
- **`documentPath`** is set by `open_document`, used by
  `requireOpenDocument()` runtime guards in every operating tool.

The per-view queue structure supports the multi-conversation use case:
each conversation's iframe has its own `viewUUID` and drains only its
own queue. When `open_document` is called from a new conversation it
broadcasts a `close_document` to all recently-live prior viewUUIDs
before returning, so prior viewers render the "Reopen the document to
continue" placeholder. **The pending map is shared** — `requestId` keys
are UUIDs and cannot collide across views.

## Wire shapes

### `ViewerCommand`

A discriminated union (`type`) of every server→viewer command.
Defined in `src/mcp/session.ts`.

```ts
type ViewerCommand =
  | { type: "get_view_state"; requestId: string }
  | { type: "set_view_state"; requestId: string; activePage?: number; ... }
  | { type: "search_exact_text"; requestId: string; query: string; ... }
  | { type: "create_annotation"; requestId: string; input: AnnotationInput }
  | { type: "close_document"; requestId: string }
  | ... // 13 more
```

Every command carries a `requestId` (UUIDv4) — the key under which
`pending` will store the resolver. The viewer dispatches in
`handleCommand(cmd)` (`src/viewer/main.ts`) and the dispatch table
mirrors the union exactly.

### `poll_commands` request → response

```jsonc
// viewer → server
{ "method": "tools/call",
  "params": { "name": "poll_commands",
              "arguments": { "viewUUID": "<the-process's-viewUUID>" } } }

// server → viewer
{ "structuredContent": { "commands": ViewerCommand[] } }
```

The server is a real long-poll: if the queue is non-empty it drains
and returns immediately; if it is empty the request is parked up to
`LONG_POLL_TIMEOUT_MS` (default 25 s, env-overridable — see
[`docs/environment-variables.md`](environment-variables.md)). An
in-process `enqueueToView` wakes the parked request via a
`pollWaiters: Map<viewUUID, () => void>` so an enqueue from any
operating tool returns immediately to the parked viewer. The
shared-state backend (`NUTRIENT_SHARED_STATE=1`) cannot deliver
cross-process wakeups, so the handler also runs a 50 ms tick that
re-checks `peekViewLength(viewUUID)` and bails as soon as a
cross-process write shows up. On viewUUID mismatch the response is
`{commands: []}` rather than an error — see "Cross-session safety"
below.

### `submit_response` request → response

```jsonc
// viewer → server
{ "method": "tools/call",
  "params": { "name": "submit_response",
              "arguments": {
                "requestId": "<from the ViewerCommand>",
                "data": <result> | null,
                "error": "optional error message"
              } } }

// server → viewer
{ "structuredContent": { "ok": true } }
```

The viewer's contract is: **`submit()` is called exactly once per
requestId** — either with `data` and no `error`, or with `data: null`
and an `error` string (the "4-clause error-payload guard" on the server
side detects the latter shape).

## The request lifecycle

This is the canonical happy path for an operating tool — say,
`search_exact_text(query, pageIndex)`:

```
1. Model              tools/call(search_exact_text, args)
                                           │
2. Server tool        ▼
   (search-exact-text.ts)  requireOpenDocument()      ✓
                           const requestId = UUID()
                           const promise = registerPending(requestId)
                           enqueue({type: "search_exact_text",
                                    requestId, query, pageIndex})
                           Promise.race([promise, timeout(30s)])
                                          │ (waiting…)
3. Viewer poll        ─────────────────────┐
   (main.ts startPolling)                  │
                           poll_commands({viewUUID})
                                           │
4. Server                ◀─────────────────┘
   (internal-tools.ts)     drain queue → return [{type, requestId, ...}]
                                           │
5. Viewer dispatch    ◀────────────────────┘
                           handleCommand(cmd)
                              → searchExactText(cmd) → instance.search(...)
                              → submit(requestId, hits)
                                           │
6. Server submit_response   ◀──────────────┘
   (internal-tools.ts)     resolvePending(requestId, hits)
                           // search-exact-text.ts's promise resolves
                                           │
7. Server tool        ◀────────────────────┘
   (search-exact-text.ts)  return {content, structuredContent: {hits}, _meta}
                                           │
8. Model              ◀────────────────────┘   tools/call result
```

### `open_document` is special-cased

`open_document` does not enqueue a viewer command. Instead it:

1. Generates a new `viewUUID` for the incoming conversation's iframe.
2. **Broadcasts `close_document`** to every viewUUID that polled within
   the last 5 s (the "recently live" window). Each broadcast is
   `enqueueAndWaitForView(targetUUID, {type:"close_document",…},
   requestId, CLOSE_BROADCAST_TIMEOUT_MS)`. If a prior viewer doesn't
   ack within `CLOSE_BROADCAST_TIMEOUT_MS` (default 2 s), the broadcast
   times out and proceeds anyway — the prior iframe is likely already
   gone. All broadcasts run in parallel via `Promise.allSettled`.
3. Updates session state (`clearOpenDocument`, `setActiveViewUUID`,
   `setOpenDocument`, `startWatching`).
4. Returns `{documentPath, viewUUID}` in `structuredContent`.

```
1. Model              tools/call(open_document, {path})
2. Server tool        validate path
                      newViewUUID = randomUUID()
                      broadcast close_document to liveViews (≤2 s wait each)
                      setActiveViewUUID(newViewUUID)
                      setOpenDocument(abs)
                      startWatching(abs)
                      return {structuredContent: {documentPath, viewUUID: newViewUUID},
                              _meta: {viewUUID: newViewUUID, ui: {resourceUri}}}
3. Host renders the iframe (resourceUri triggers resources/read)
4. Iframe boots; ontoolresult fires with the open_document result
5. Iframe handler reads structuredContent.documentPath, calls
   openDocumentFromPath() — which calls
   app.readServerResource({uri:"nutrient-doc:///current"}) once to get
   the bytes as a single base64 blob, then NutrientSDK.load()
```

Why open is special: the new iframe doesn't yet exist when `open_document`
is called. There's no polling loop to deliver an enqueued command to.
Instead, the tool result *itself* triggers iframe creation, and the
iframe self-bootstraps from `structuredContent`.

Every other operating tool runs after the iframe is alive and polling,
so they can use the enqueue + wait pattern.

## Why long-poll over direct PostMessage

The Node MCP server can't talk PostMessage to the iframe directly — the
ext-apps protocol routes through the host (Cowork). The host forwards
`tools/call` invocations from the iframe to the server, but it doesn't
expose a server→iframe push channel. So the only direction we
genuinely have is **iframe → server**.

Two ways to flip that:

1. **Direct PostMessage** — the server somehow gets a `Window` handle
   and pushes commands. *Doesn't work*: the server is in Node, and the
   host owns the iframe lifecycle.
2. **Long-poll** — the iframe asks the server "do you have anything
   for me?" repeatedly, and the server replies with whatever's queued.
   *Does work*: just two `tools/call` invocations going the same
   direction the host already supports.

Bonuses of the long-poll shape:

- **Driver-agnostic.** The server doesn't care what host implementation
  delivers tool calls; it just sees `tools/call` messages.
- **Resilient to reconnect.** If the iframe reloads, the queue still
  has anything that hadn't been drained — the new iframe with the same
  viewUUID picks up where the prior one left off.
- **Trivial to test.** The integration tests just spin up the server,
  send fake `poll_commands` calls, and inspect `submit_response`
  payloads. No browser, no PostMessage shim.

## Cross-session safety

`poll_commands` filters by `viewUUID`: requests with a UUID that is not
found in the `queues` map (i.e. not the active view and not a recently-
seen prior view) get an empty `{commands: []}` rather than an error.
This is deliberate — a stale iframe from a closed conversation will
still poll using its old UUID; we don't want that to error, just to
silently return nothing.

When a new `open_document` is called from a different conversation, the
prior view's `viewUUID` stays in `queues` long enough to receive and ack
the broadcast-close command. After that its queue is idle (empty), so
any subsequent polls return `{commands: []}` — a clean no-op.

(For the bridge polling loop, "no commands for this UUID" is the correct
answer for a recently-closed view.)

## First-response-wins for `submit_response`

If the viewer accidentally calls `submit_response` twice for the same
`requestId`:

- The first call: `pending.delete(requestId)` and `resolve(data)` (or
  `reject(error)`). The Map entry is gone.
- The second call: `pending.get(requestId)` returns `undefined`. The
  function silently returns. The double call is a no-op.

This is a deliberate choice over throwing on duplicate. A misbehaving
viewer (or a buggy SDK callback that fires twice) shouldn't take the
server down with an unhandled rejection — it should just have its
second submission ignored.

## Race-against-timeout

Every operating tool follows the same shape:

```ts
const promise = registerPending(requestId);
enqueue(cmd);
const result = await Promise.race([
  promise,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Viewer never responded")),
               VIEWER_TIMEOUT_MS)
  ),
]);
```

`VIEWER_TIMEOUT_MS` is 30s by default (env-overridable). The race
ensures a non-responsive iframe (crashed, off-screen too long, etc.)
returns a clear error instead of hanging the model's tool call
forever. After timeout, the Pending entry is cleaned by the rejector.

The `apply_annotations` tool re-implements this race locally rather
than via a shared helper — that's intentional, the elicitation flow is
a tight enough loop that inlining keeps it auditable.

## Invariants worth re-stating

- `viewUUID` is generated **once per `open_document` call** (via
  `randomUUID()`) and remains stable for that conversation's iframe
  lifetime. A new conversation calling `open_document` gets a new
  `viewUUID`; the prior conversation's iframe retains its old one.
- `viewUUID` is read **once** per iframe page load from
  `ontoolresult._meta.viewUUID` (not `ontoolinput._meta` — that path
  silently never delivers the UUID, leaving the viewer stuck) and
  never changes during that page's lifetime.
- `enqueue + registerPending(requestId)` ordering: **register pending
  first**, then enqueue, then race the timeout. If you enqueue before
  registering, the viewer can drain + reply before the resolver
  exists, and the response is dropped.
- `submit()` is called exactly once per `requestId` from the viewer
  side (data or error).
- A duplicate `submit_response` for the same `requestId` is a silent
  no-op on the server.
- A `ViewerCommand` whose `type` is unknown to the viewer is silently
  ignored (no throw), so adding new server-side commands doesn't break
  old viewer bundles.
- `startPolling` runs exactly once per page load — guarded by a
  `pollingStarted` flag because `ontoolresult` fires on every tool
  result.

## Code map

### Server side
| File | Responsibility |
|---|---|
| [`src/mcp/session.ts`](../src/mcp/session.ts) | `STATE` singleton, `ViewerCommand` union, `enqueue` / `drain` / `registerPending` / `resolvePending` / `rejectPending` |
| [`src/mcp/internal-tools.ts`](../src/mcp/internal-tools.ts) | `poll_commands` and `submit_response` tool handlers |
| [`src/mcp/tools/*.ts`](../src/mcp/tools/) | Operating tools — each follows the registerPending → enqueue → race pattern |
| [`src/mcp/tools/open-document.ts`](../src/mcp/tools/open-document.ts) | The exception — returns directly without enqueueing |
| [`src/mcp/tool-registry.ts`](../src/mcp/tool-registry.ts) | Filters `poll_commands` / `submit_response` out of `tools/list` |
| [`src/mcp/document-resource.ts`](../src/mcp/document-resource.ts) | Registers the `nutrient-doc:///current` MCP resource that returns the open document's bytes as a single base64 blob; iframe-internal, skips path-guard |

### Iframe side
| File | Responsibility |
|---|---|
| [`src/viewer/main.ts`](../src/viewer/main.ts) | `startPolling` long-poll loop, `handleCommand` dispatch table, per-command handlers, `submit()` helper |

## Stale-view sweep

`pruneStaleViews()` runs on a 30 s `setInterval` in `src/mcp/index.ts`
after the server connects. It iterates the `liveViews` heartbeat map
(not `queues` — drained queues are empty by definition and so a
useless source of liveness) and drops any viewUUID whose last poll
was older than `VIEW_TTL_MS` (60 s) from `liveViews`, `queues`, and
`pollWaiters`. Any parked waiter gets resolved before deletion so
its `poll_commands` returns a clean empty result instead of leaking
the closure for the full long-poll timeout. The interval is `.unref()`
so the sweep doesn't keep the process alive on its own.

Without this sweep, a closed conversation's iframe — which keeps
polling under its old viewUUID — would leak entries forever. We
observed exactly this in production logs (one viewUUID polled
~12 000 times over 18 idle hours).
