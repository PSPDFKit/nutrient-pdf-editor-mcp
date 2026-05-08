# CSP Allowlist for the Embedded Viewer SDK

Last verified: 2026-05-01

This doc is the canonical reference for the `_meta.ui.csp` configuration in
`src/mcp/app-resource.ts`. Read it before changing that file.

CSP-only concern. License policy lives in a separate task; the MCP server does
not implement any ping or telemetry client — the Viewer SDK handles those calls
itself.

## Why CSP Gates the Iframe

The MCP App iframe runs under a `Content-Security-Policy` that restricts the
origins the embedded app can contact. Without an explicit allowlist the Nutrient
Viewer SDK's outbound requests are blocked. The relevant CSP violations that
motivated this allowlist were tracked in
`modelcontextprotocol/ext-apps#387` and `#410`.

The host constructs the CSP from the `_meta.ui.csp` field declared by the MCP
server. Every origin the SDK contacts at runtime must appear in either
`connectDomains` (XHR/fetch/WebSocket) or `resourceDomains`
(scripts, stylesheets, fonts, images, WASM workers), or the request is blocked.

## Two Declaration Sites

The `_meta.ui.csp` field is declared in two places in `src/mcp/app-resource.ts`:

1. **Registration metadata** — passed as the `config` argument to
   `registerAppResource(...)`. Included in the `resources/list` response and
   acts as a static default that hosts can inspect at connection time.

2. **`resources/read` content item** — returned inside each `contents[0]._meta`
   when the read callback fires. Per `modelcontextprotocol/ext-apps#410`, the
   content-item value **takes precedence** over the registration-level value if
   a host honours both.

We declare the same CSP at both sites for two reasons:
- Some hosts only read the `resources/list` default and do not re-read the
  content item before rendering.
- Some hosts apply only the content-item value.
Declaring in both ensures the widest host compatibility.

Both sites are driven by the `buildCsp(assetOrigin)` helper so they cannot
drift. The lockstep invariant is enforced by the unit test in
`tests/mcp/app-resource.test.ts`.

## Current Allowlist

| Entry | Directive(s) | Purpose |
|-------|--------------|---------|
| `assetOrigin` = `https://cdn.cloud.nutrient.io` (`NUTRIENT_CDN_ORIGIN` in `app-resource.ts`) | `connectDomains` + `resourceDomains` | Nutrient SDK runtime chunks, WASM, fonts (version-pinned CDN). Already covered by the `https://*.nutrient.io` wildcard, but listed explicitly to keep the legacy `[assetOrigin, ...wildcards]` shape — see `app-resource.ts:18-21`. |
| `https://*.nutrient.io` | `connectDomains` + `resourceDomains` | Nutrient services and assets under `nutrient.io` (CDN, fonts, license, telemetry) |
| `https://*.nutrient-powered.io` | `connectDomains` + `resourceDomains` | Nutrient services under `nutrient-powered.io` (e.g., `dam.our.services.nutrient-powered.io` — metrics POST to `/proto/metrics`) |

Both wildcard patterns are applied to both `connectDomains` and
`resourceDomains` because a given Nutrient subdomain may serve both XHR-style
calls and sub-resources (fonts, WASM) depending on the SDK version.

## Why Wildcards (Forward-Compatibility)

Nutrient ships a number of subdomains under `*.nutrient.io` and
`*.nutrient-powered.io` for analytics, licensing, CDN delivery, and telemetry.
SDK upgrades introduce new subdomains over time. Enumerating the live set in a
snapshot makes the allowlist a moving target: every SDK bump risks a silent CSP
regression.

Wildcard entries bounded to Nutrient-controlled domain families avoid
per-subdomain churn. A new `metrics-v2.our.services.nutrient-powered.io`
endpoint appearing in a future SDK release works without a follow-up CSP PR.

Wildcard support on `connectDomains` was verified empirically during the
initial implementation (2026-04-30): Claude Desktop honoured
`https://*.nutrient.io` on `connect-src` with no violations for
Nutrient-origin requests.

## Bounded Scope

The wildcards are explicitly NOT:
- `*` (bare wildcard — blocked by spec)
- `https://*` (overly broad — allows any HTTPS origin)

They cover only `*.nutrient.io` and `*.nutrient-powered.io`, both of which are
Nutrient-controlled domain families. The CDN asset origin
(`https://cdn.cloud.nutrient.io`) is technically already covered by the
`https://*.nutrient.io` wildcard, but it is also listed explicitly as
`assetOrigin` so the CSP arrays preserve the legacy
`[assetOrigin, ...wildcards]` shape and keep an explicit entry alive
under host implementations that may not honour wildcards on `connect-src`.

## Empirical-Test Recipe (Run on Host Upgrade or SDK Upgrade)

Rerun this procedure whenever Claude Desktop ships a new host version or
`@nutrient-sdk/viewer` is bumped.

1. Build and package:
   ```
   npm run build && npm run build:mcpb
   ```
2. Install `build/nutrient-pdf-editor-<version>.mcpb` in Claude Desktop
   (drag-drop into Settings, or update the MCP config to point at
   `dist/index.js --stdio`).
3. Open Claude Desktop developer tools (`View -> Developer -> Toggle Developer
   Tools`). Switch to the Network tab; enable "Preserve log"; clear the log.
4. Open a chat; trigger `open_document` against a real PDF in
   your declared roots.
5. Console tab — filter by `Content Security Policy`.
   - **Pass:** zero violations for any host containing `nutrient` or
     `nutrient-powered`.
   - **Fail:** any CSP violation for a `*.nutrient*` origin — capture the
     blocked origins and replace the wildcard patterns in
     `NUTRIENT_VIEWER_DOMAIN_PATTERNS` (`src/mcp/app-resource.ts`) with a
     named-origin list, then update `tests/mcp/app-resource.test.ts` to
     match.
6. Network tab — sort by Domain. Confirm:
   - `POST https://dam.our.services.nutrient-powered.io/proto/metrics` returns
     2xx (not `(blocked:csp)`).
   - `https://cdn.cloud.nutrient.io/pspdfkit-web@<version>/...` SDK runtime
     chunks (JS, WASM, fonts) all return 200 (not `(blocked:csp)`).

## Source-of-Truth Pointers

- Patterns live in `src/mcp/app-resource.ts` as
  `NUTRIENT_VIEWER_DOMAIN_PATTERNS` and `buildCsp()`.
- Lockstep and bounded-scope assertions live in
  `tests/mcp/app-resource.test.ts`.
- Wildcard feasibility: verified empirically 2026-04-30 (see § Why
  Wildcards above); no separate research file.

