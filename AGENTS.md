# Nutrient PDF Editor

Last verified: 2026-05-06

Agent-facing entry point. This file points you at the canonical docs;
follow the links rather than relying on prose here.

Nutrient PDF Editor is a Claude Connector — a stdio MCP server packaged
as an `.mcpb` bundle that installs into Claude Desktop and renders its
PDF viewer inside Claude Cowork. The embedded Nutrient Web Viewer loads
its runtime assets from the public Nutrient CDN at first launch (network
required). For the runtime model, the public tool surface, the wire
protocol, and CSP, follow the links below.

## Where things live

- [`docs/distribution/claude-connector.md`](docs/distribution/claude-connector.md)
  — what this Connector is, where it runs, how to install.
- [`docs/build-and-distribution.md`](docs/build-and-distribution.md)
  — npm scripts, build pipeline order, MCPB packaging, version
  pinning, SDK upgrade procedure.
- [`docs/tool-surface.md`](docs/tool-surface.md) — the 17 public
  PDF-editor tools, the 3 internal viewer-only tools, the
  `nutrient-doc:///current` document-bytes resource, runtime guards,
  no-`listChanged` policy.
- [`docs/response-shapes.md`](docs/response-shapes.md) — CallToolResult
  shape, Immutable.List boundary rule, version pinning.
- [`docs/error-conventions.md`](docs/error-conventions.md) — `McpError`
  convention, viewer→server error convention, timeouts.
- [`docs/environment-variables.md`](docs/environment-variables.md) — all
  `NUTRIENT_*` and `VITE_NUTRIENT_*` env vars.
- [`docs/auto-save.md`](docs/auto-save.md) — auto-save loop, terminal
  flush, `flushIfDirty` vs `flushNow`.
- [`docs/bridge-protocol.md`](docs/bridge-protocol.md) — wire
  protocol (poll/submit shapes, `viewUUID` lifecycle, request
  lifecycle, timeout race).
- [`docs/document-lifecycle.md`](docs/document-lifecycle.md) —
  open / close / in-place-switch state machine.
- [`docs/csp-allowlist.md`](docs/csp-allowlist.md) — wildcard origin
  allowlist for the embedded Nutrient Web Viewer; read before changing
  `_meta.ui.csp` in `src/mcp/app-resource.ts`.
- [`docs/manual-qa.md`](docs/manual-qa.md) — copy-paste Cowork prompt
  that exercises all 16 public tools against `tests/fixtures/`; use as
  a release smoke test.
- [`src/mcp/AGENTS.md`](src/mcp/AGENTS.md) — server-specific agent
  guidance, server boundaries, server-side gotchas.
- [`src/viewer/AGENTS.md`](src/viewer/AGENTS.md) — viewer-specific
  agent guidance, viewer boundaries, SDK-API gotchas.

## Boundaries

- Safe to edit: `src/`, `tests/`, `scripts/`, `docs/`, manifest/config.
- Never touch without coordinated version bump:
  `package.json#version` and `manifest.json#version` —
  `verify-versions.mjs` fails the build if they drift.
- SDK bumps require `npm install` + rebuild so
  `__NUTRIENT_SDK_VERSION__` is re-inlined into `dist/index.js`. See
  [`docs/build-and-distribution.md` § "SDK upgrade procedure"](docs/build-and-distribution.md#sdk-upgrade-procedure).

## Gotchas

Server-side gotchas live in [`src/mcp/AGENTS.md`](src/mcp/AGENTS.md)
§ "Gotchas". Viewer / SDK-API gotchas live in
[`src/viewer/AGENTS.md`](src/viewer/AGENTS.md) § "Gotchas". Read both
before debugging anything that "just hangs" or "silently fails".
