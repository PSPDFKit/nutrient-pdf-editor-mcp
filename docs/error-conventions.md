# Error conventions

Last verified: 2026-05-04

Defines how errors are thrown by tool handlers (`McpError`), how viewer-originated errors are detected and rethrown, and how the viewer submits errors back over the bridge.

See also: [`response-shapes.md`](response-shapes.md), [`bridge-protocol.md`](bridge-protocol.md).

## McpError convention

Tool handlers throw `McpError` with `ErrorCode` (never plain `Error`
or `throw {}`). Viewer-originated errors are detected via the
4-clause guard:

```ts
errorPayload && typeof errorPayload === "object"
  && "error" in errorPayload
  && typeof errorPayload.error === "string"
```

and rethrown as `McpError(InvalidParams, errorPayload.error)`. The
verbose guard avoids false positives from `typeof === "string"`
checks against arbitrary payloads.

## Viewer → server error convention

The viewer calls `submit(requestId, null, "message")`; the data
payload is `null`, the error message is the third arg. Never wrap
error state inside `data`. Error messages surface to the MCP client
verbatim as `McpError(InvalidParams, "...")` — keep them
user-readable, since they appear in Cowork verbatim.

## Timeouts

Every server→viewer round-trip races `Promise.race` against
`VIEWER_TIMEOUT_MS` (default 30000 ms). The race + 4-clause
viewer-error guard live in `src/mcp/bridge.ts` as
`enqueueAndWait<T>(command, requestId, timeoutMs?)`; every public
operating tool composes its handler around it. `McpError` rejections
are rethrown as the same JS instance, so inner `ErrorCode` values
survive the round trip — the inline-vs-helper inconsistency the audit
flagged (CR-005) is closed. The single deliberate exception is
`tools/apply-annotations.ts`, which keeps a local copy of
`enqueueAndWait` for auditability of the elicitation flow (see
`src/mcp/AGENTS.md` Gotchas).

## 4-clause error-payload guard (design rationale)

The viewer reports validation errors via `submit(id, null, "message")`,
which the SDK transport surfaces as a plain object with an `error`
string. We detect these with a verbose guard (truthy + object +
key-present + string) instead of `typeof === "string"` to avoid false
positives.

## `initialize` handshake rejection

`initialize` is rejected with `McpError(InvalidRequest, …)` when the
client does not advertise the MCP Apps `io.modelcontextprotocol/ui`
extension with `text/html;profile=mcp-app` in `mimeTypes` (read from
either `capabilities.extensions[…]` or, leniently,
`capabilities.experimental[…]`). The server never moves out of the
pre-initialised state on rejection. See
`src/mcp/require-ui-capability.ts` for the implementation and
`tests/mcp/init-rejection.test.ts` for the rejection-shape contract.

The success path duplicates the SDK's default `_oninitialize` body
verbatim so `oninitialized` and `getClientCapabilities()` keep working
unchanged.
