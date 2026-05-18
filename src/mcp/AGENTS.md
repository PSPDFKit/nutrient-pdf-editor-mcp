# src/mcp — MCP Server

Last verified: 2026-05-01

## Purpose

Implements the stdio MCP server: one tool per public capability and a
per-session command queue that the viewer iframe long-polls. The
Nutrient Web Viewer is loaded by the iframe directly from the public
Nutrient CDN — see `app-resource.ts`.

This file is agent-facing. The contract / decision / invariant prose
that used to live here moved to `docs/`; the links below are the
canonical homes.

## Where things live

- [`docs/tool-surface.md`](../../docs/tool-surface.md) — server
  contracts (Exposes / Guarantees / Expects), the 17 public tools,
  the 3 internal viewer-only tools, the `nutrient-doc:///current`
  document-bytes resource, runtime guards, no-`listChanged` policy.
- [`docs/response-shapes.md`](../../docs/response-shapes.md) — response
  shape rules.
- [`docs/error-conventions.md`](../../docs/error-conventions.md) —
  `McpError` convention and viewer→server error shape.
- [`docs/environment-variables.md`](../../docs/environment-variables.md) —
  every `NUTRIENT_*` / `VITE_NUTRIENT_*` env var.
- [`docs/auto-save.md`](../../docs/auto-save.md) — auto-save loop,
  terminal-flush list.
- [`docs/bridge-protocol.md`](../../docs/bridge-protocol.md) — wire
  protocol the server speaks to the iframe.
- [`docs/document-lifecycle.md`](../../docs/document-lifecycle.md)
  — full open / close / in-place-switch state machine, the
  iframe-side atomic-SDK-swap design, the rationale for
  no-headless-mode and no-server-side-close-then-open, and the
  placeholder semantics.
- [`shared-state/README.md`](shared-state/README.md) —
  file-backed `SessionBackend` for the multi-process workaround;
  trade-offs and strip-out criteria.

## Boundaries

- Must NOT import from `src/viewer/**` at runtime (those are bundled
  into a separate browser target). The only allowed cross-boundary
  import is *types* via `src/contract/**` (P1-5: shared-type layer).
- Every public tool accepts a typed zod shape; never `z.any()` at
  the tool boundary.
- Every operating-tool handler calls `requireOpenDocument()` and
  `requireFreshDocument()` from `document-guard.ts` as its first
  two statements. `close_document` is the only exception (idempotent
  no-op pre-open; closing a stale document is a valid user action).

## Gotchas

- The `nutrient-doc:///current` resource handler is registered as a
  static URI (not a URI template) on purpose — there's nothing to
  parse, the source path comes from session state. If you ever
  templatize it, you must add the path-guard back.
- `apply-annotations.ts` uses the shared `bridge.ts` `enqueueAndWait`
  for both the read_annotations and apply_redactions_now round-trips.
  The elicitation flow sits between the two calls; it keeps the full
  sequence auditable in one file without needing a local copy.
- `set_view_state` rejects empty input
  (`activePage === undefined && scrollTo === undefined &&
  selection === undefined`); the viewer should never receive a no-op
  command.
- When `search_exact_text` is called without a loaded instance, the
  viewer submits an `error` payload, which surfaces as
  `McpError(InvalidParams)` — not an empty `hits: []`.
- `read_document_information` returns the SDK's raw 8-key
  `DocumentPermissions` record from `instance.getDocumentPermissions()`
  (async); the 4-key projection once returned by the viewer was
  based on a non-existent `instance.permissions` property and is
  gone.
- `viewUUID` is re-emitted on every result so the viewer can
  bootstrap `startPolling` on first tool response; this is
  load-bearing and intentional.
