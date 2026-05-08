# Public tool surface

Last verified: 2026-05-01

This doc owns the MCP-facing tool inventory: the public 17-tool table,
the three internal viewer↔server tools, the runtime guards every
operating tool calls, and the `tools.listChanged` policy. The wire
protocol that backs every tool round-trip is in
[`bridge-protocol.md`](bridge-protocol.md). The open / close /
in-place-switch state machine is in
[`document-lifecycle.md`](document-lifecycle.md).

## Server contracts (overview)

- **Exposes** to MCP clients: 16 public tools (gated by
  session state — see [Runtime guards](#runtime-guards)).
- **Exposes** to the iframe only: `poll_commands(viewUUID)` (drain
  queue), `submit_response(requestId, data, error?)` (resolve/reject
  the server-side pending Promise), and
  `write_document_bytes(offset, byteCount, dataBase64, isFinal, documentPath)`
  (chunked base64 iframe→server save-back, max 2 MiB per call;
  `documentPath` carries the path the iframe captured at save-start
  time and the server rejects any chunk where it doesn't match the
  current session path — see
  [`document-lifecycle.md` § "In-flight save during in-place SDK swap"](document-lifecycle.md#in-flight-save-during-in-place-sdk-swap)).
- **Document reads** are not a tool — see
  [Document reads as a resource](#document-reads-as-a-resource).
- **Guarantees:**
  - All tool errors are `McpError` with an `ErrorCode` (never plain
    `Error`, never `throw {}`).
  - `initialize` is rejected when the client does not advertise the
    MCP Apps `io.modelcontextprotocol/ui` extension. See
    [`error-conventions.md` § "initialize handshake"](error-conventions.md#initialize-handshake-rejection).
  - Every tool round-trip races a `VIEWER_TIMEOUT_MS` timeout
    (default 30000).
  - `_meta.viewUUID` is always present on success results so the
    viewer can bind.
  - Path arguments on **model-callable** tools (`open_document` etc.)
    are validated against MCP client-advertised roots (per the
    spec's `roots/list` mechanism) via `path-guard.ts`. The server
    fails fast if the client hasn't declared the `roots` capability
    and exposed at least one root — there is no env-var fallback. VM
    paths from Claude-in-Cowork are rewritten onto the first
    advertised root that contains the file.

## Public tools

Sixteen public tools (stable, MCP-facing).
All 16 tools are advertised statically in `tools/list`. Operating
tools enforce two runtime contracts via
`src/mcp/document-guard.ts`. The remedy for staleness is
`close_document` + `open_document` — there is no merge or live
reload. `close_document` is special-cased to be an
idempotent no-op pre-open.

| Tool | Purpose |
|------|---------|
| `open_document` | Open PDF/DOCX/XLSX/PPTX/PNG/JPG/TIFF in the iframe with full UI mounted. Calling again with a different path does an in-place SDK swap inside the iframe (no server-side close cycle, no transitional blank state). |
| `close_document` | Tear down the SDK instance and clear session state. Idempotent no-op when no document is open. |
| `get_view_state` | Current page, page count, document path. |
| `set_view_state` | Navigate / scroll / select (at least one field required). |
| `search_exact_text` | Exact-text search with optional page scope. |
| `read_document_information` | `pageCount`, title, permissions. |
| `read_page_info` | `width`, `height`, `rotation`. |
| `get_page_image` | Rendered page as an MCP `image` content block (PNG, base64) plus a metadata text block; `structuredContent` carries `pageWidth` / `pageHeight` / `renderedWidth` only — the bitmap is never inlined into a string field. |
| `read_text` | Plain text of an open document, with optional 0-based `pageStart`/`pageEnd` range; auto-paginates at a 100K-char cap by trimming back to the last full page that fits. |
| `create_annotation` | Create one of 10 annotation types (discriminated union). |
| `read_annotations` | Filter by `pageIndex` and/or `type`. |
| `update_annotation` | Patch annotation by id. |
| `delete_annotation` | Delete annotation by id. |
| `apply_annotations` | Apply redactions — dual gate: tool description requires the model to confirm in chat, plus a host-rendered elicitation form when the client advertises `capabilities.elicitation`. |
| `read_form_fields` | Returns `Serializers.FormFieldJSON` shape (with `pageIndex`/`rect` extensions); optional page scope. |
| `update_form_field_values` | Fill text/checkbox/radio/combobox/listbox with validation. |

## Internal tools

Three internal tools (viewer → server only, hidden from `tools/list`):

- `poll_commands(viewUUID)` — drain pending server→viewer commands.
- `submit_response(requestId, data, error?)` — resolve/reject the
  server-side pending Promise.
- `write_document_bytes(offset, byteCount, dataBase64, isFinal, documentPath)` —
  chunked base64 iframe→server save-back. Target path is read from
  `SessionBackend.getDocumentPath()` (set and path-guarded at
  `open_document` time); the destination is server-controlled.
  `documentPath` is the iframe's stream-binding tag — the path the
  auto-save controller captured at setup time, threaded through every
  chunk. The server rejects any chunk where `documentPath !==
  getDocumentPath()` so an in-flight save against the prior document
  cannot clobber a freshly-opened new document after an in-place SDK
  swap. See `docs/document-lifecycle.md` § "In-flight save during
  in-place SDK swap".

Filtered out via a custom `tools/list` handler in
`src/mcp/tool-registry.ts` (`installInternalToolsFilter()`). Still
callable via `tools/call` from the iframe.

## Document reads as a resource

Document **reads** are not a tool at all — the iframe fetches the file
bytes in one shot via the `nutrient-doc:///current` MCP resource using
`app.readServerResource` (handler in `src/mcp/document-resource.ts`).
The handler reads `getSession().documentPath` and returns the full
file as a single base64 `blob`.

Why a resource and not a tool: the flow has no business showing up in
`tools/list` and gains nothing from chunked transport. Writes still
need a chunked tool (`write_document_bytes`) because resources are
read-only and SDK-exported PDFs can be too large for a single message.
The resource handler skips the path-guard because `open_document`
already validated the path; the resource is iframe-internal trust.

## Runtime guards

Every operating-tool handler calls three guards from
`document-guard.ts`, in this order, as its first three statements:

- **`requireValidLicense()`** (order 1) — throws `McpError(InvalidParams,
  <guidance>, {code: "LICENSE_ERROR", …})` when the viewer reported a
  license failure during the most recent SDK load. Fails fast so
  subsequent tool calls return a clear license error rather than
  silently hanging waiting for a viewer that won't respond. The error
  `data` field carries `code: "LICENSE_ERROR"` and `subKind` for
  programmatic discrimination.
- **`requireOpenDocument()`** (order 2) — throws
  `McpError(InvalidParams, "No document is currently open. Call
  open_document first.")` when no document is open.
- **`requireFreshDocument()`** (order 3) — throws
  `McpError(InvalidParams, "Document on disk has changed since it was
  opened…")` when the staleness watcher (or the write-side pre-rename
  stat-compare in `write_document_bytes`) has flipped the dirty flag.

The 14 guarded operating tools are: `get_view_state`,
`set_view_state`, `search_exact_text`, `read_document_information`,
`read_page_info`, `get_page_image`, `read_text`, `create_annotation`,
`read_annotations`, `update_annotation`, `delete_annotation`,
`apply_annotations`, `read_form_fields`, `update_form_field_values`.
The internal `write_document_bytes` calls `requireValidLicense()` and
`requireFreshDocument()` plus an explicit `documentPath === null` check
(it would be redundant for the writer to call `requireOpenDocument()`
because the destination is read from session state, not the model).

`close_document` is special-cased to be an idempotent no-op pre-open
and intentionally does NOT call `requireFreshDocument()` — closing a
stale document is a valid user action.

## Tool advertisement (no `listChanged`)

The server does NOT declare `tools.listChanged: true` and never emits
`notifications/tools/list_changed`. The set of advertised tools is
fixed for the entire process lifetime. We chose static advertisement
+ runtime guards over the SDK's `.enable()` / `.disable()` mechanism
because the dynamic-disclosure model didn't propagate into the MCP
hosts we ship to. With this combo, the contract is identical from the
model's perspective and works reliably across hosts.
