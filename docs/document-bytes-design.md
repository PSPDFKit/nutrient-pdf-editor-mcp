# Document Bytes — Why a Resource, Not a Tool

The viewer iframe needs the bytes of the file the model just opened so it can
hand them to `NutrientSDK.load`. We move those bytes through the MCP
**resources** layer, not through a tool. This doc explains why direct
`file://` loading was off the table, why a resource beat a chunked tool, and
what would have to change to revisit the constraint.

## How it works today

1. `open_document` validates the path against the MCP-advertised roots, writes it to session state, and returns to the model immediately with `{documentPath, viewUUID}`.
2. The iframe reads `structuredContent.documentPath` from `ontoolresult` and calls `app.readServerResource({ uri: "nutrient-doc:///current" })` once.
3. The host proxies that to a `resources/read` request on our server. The handler in `src/mcp/document-resource.ts` reads `getSession().documentPath` and returns the file as a single base64 `blob` in one response.
4. The viewer base64-decodes and hands the `ArrayBuffer` to `NutrientSDK.load`.

Single round-trip. Same wire-size envelope as base64-over-stdio would have any other way; the win is one message instead of N.

## Why not let the SDK fetch `file://` directly

The Nutrient SDK supports `NutrientSDK.load({ document: "file:///abs/path.pdf" })` in vanilla Electron. We tested it inside the MCP Apps iframe sandbox under Claude Desktop. Two walls — both upstream — keep it from working:

**Wall 1: the host strips non-https from `connectDomains`.** We declared `file:` as a scheme-source in `_meta.ui.csp.connectDomains`. The browser's CSP error and the iframe's outer URL both confirm the host filtered it before constructing `connect-src`:

```
connect-src 'self' https://cdn.cloud.nutrient.io https://*.nutrient.io https://*.nutrient-powered.io
```

`file:` is missing. The host (Claude Desktop, and likely Cowork) validates origins as URLs and drops anything that isn't https. Spec issue tracking the broader CSP-fidelity gap is linked in the references below.

**Wall 2: browser-level mixed content.** The iframe is served from an `https://assets.claude.ai`-style origin. Even if the host honoured `file:` in `connectDomains`, Chromium refuses https→file `fetch` regardless of CSP. Removing this wall would require a host-side custom-scheme handler (e.g. `mcpdoc://` registered by Electron's main process) — the MCP Apps spec has no hook for plugins to register one.

The ext-apps `permissions` field covers camera/mic/geolocation/clipboard only. There is no opt-in elevation for filesystem access.

## Why a resource over a chunked tool

Once direct file loading was ruled out, bytes had to travel through the MCP transport. Three shapes were on the table:

| Shape | Round-trips | Surface | Verdict |
|---|---|---|---|
| **Chunked tool** (`read_document_bytes` × N) | ⌈size / chunk⌉ | iframe-internal tool, filtered from `tools/list` | What we had. Per-chunk JSON-RPC overhead is real; 50 MB doc = ~100 round-trips at 512 KiB chunks. Filter machinery just to hide it. |
| **Single-shot tool** (`read_document_bytes` × 1) | 1 | Same surface as above | Smallest diff but still pollutes `tools/list` filter for a function that conceptually isn't a tool. |
| **Resource** (`resources/read nutrient-doc:///current`) | 1 | Standard MCP `resources` layer; not in the tool surface at all | **Chosen.** Same wire cost as single-shot; idiomatic MCP shape; nothing to filter. |

`app.readServerResource` is documented in `@modelcontextprotocol/ext-apps` as the channel for "files, data, or other content provided by the MCP server" with `file:///path/to/file` cited as a valid URI form. The host proxies the call to our server's `resources/read` handler — same JSON-RPC-over-stdio transport as `tools/call`, no new wire considerations.

## Static URI, not a template

The resource is registered at the literal URI `nutrient-doc:///current`, not as a `{path}`-templated resource:

- The handler reads `getSession().documentPath` directly. No URI parsing.
- No path-guard duplication: `open_document` already validated the path before writing it into session state. The handler can trust it.
- The model could call `resources/read` with this URI itself, but it would only ever get back the document it itself just opened — no privilege escalation surface.
- A templated form (`nutrient-doc:///{+path}`) would re-introduce the path-guard requirement and add a `resources/templates/list` filter step.

If the resource is ever templatized — e.g. to pre-fetch siblings or expose a thumbnail derivative — the path-guard must be added back.

## What would have to change to revisit

We'd consider going back to direct file loading if:

- The MCP Apps spec gains a custom-scheme registration mechanism *and* hosts implement it. Resolves both walls in one go.
- Or the host adopts a permission like `localFileRead` that grants `file:` reachability from the iframe. Resolves wall 1; wall 2 still needs a same-origin or scheme bridge.

We'd consider chunking again only if a real document blows past the host's stdio→postMessage message-size ceiling. Empirical limit is unmeasured; PDFs in the tens of MB work fine in Claude Desktop today (verified end-to-end at ~232 KB base64 with ~4 ms server-side handling). For documents in the hundreds of MB, a hybrid (single-shot under N MiB, chunked above) might be worth re-introducing — defer until a real need surfaces.

## References

- [ext-apps spec — apps.mdx](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
- ext-apps `App.readServerResource` types: `node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts`
- MCP SDK `server.registerResource`: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js`
- [anthropics/claude-ai-mcp#40](https://github.com/anthropics/claude-ai-mcp/issues/40) — host hardcodes parts of CSP, ignores some declared domains
- Bridge protocol: [`bridge-protocol.md`](bridge-protocol.md)
- Document lifecycle: [`document-lifecycle.md`](document-lifecycle.md)
