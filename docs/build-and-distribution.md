# Build and distribution

Last verified: 2026-05-08

This doc owns the npm scripts, the build pipeline order, and the MCPB
distribution-artefact packaging. Per-channel publishing notes live under
[`distribution/`](distribution/).

## Network requirement

The viewer HTML produced by this build is the **CDN flavour**: the
Nutrient SDK script bundle, worker, and wasm assets are not embedded in
`mcp-app.html`. They are fetched at runtime from
`https://cdn.cloud.nutrient.io/pspdfkit-web@<version>/`. The MCPB
therefore requires network access on first launch (cached indefinitely
thereafter); offline use is not supported.

## Commands

- `npm run build` — `verify-license-env.mjs` → typecheck (server +
  viewer tsconfigs) → Vite build → esbuild (with
  `__NUTRIENT_SDK_VERSION__` inlined via `define`) → `verify-dist.mjs`
  → `verify-versions.mjs` → `verify-server-name.mjs` →
  `verify-registry-sync.mjs` → `verify-manifest-tools.mjs` →
  `build:mcpb`. Produces a single artefact:
  `build/nutrient-pdf-editor-mcp-<version>.mcpb` (~1.2 MB) that
  installs into Claude Desktop; Cowork is what actually renders the
  iframe at runtime.
- `npm run verify:license-env` — run the license-env guard alone (the
  same check `npm run build` runs as step 0).
- `npm run build:mcpb` — stage `dist/{index.js, mcp-app.html}`
  under `server/` and pack via `npx @anthropic-ai/mcpb pack`.
- `npm run test` — Vitest (unit + integration).
- `npm run ping` — `node dist/index.js --ping` sanity check.
- `npm run verify:versions` — assert
  `package.json#version` and `manifest.json#version` match.
- `npm run verify:server-name` — assert the host-routing display name
  matches across `manifest.json#display_name` and the
  `new McpServer({ name })` arg in `src/mcp/server.ts`.

## Build pipeline

The pipeline is strict-ordered. Each step depends on artefacts the
prior steps produced; reordering them breaks the build.

1. **`verify-license-env.mjs`** — fail-fast on misconfigured
   `VITE_NUTRIENT_LICENSE_KEY`. The guard reads `.env` via Vite's
   `loadEnv` and classifies the value:

   | State | Outcome |
   |---|---|
   | unset (no `.env`, or var absent) | fail |
   | matches `<YOUR_LICENSE_KEY_HERE>` placeholder from `.env.example` | fail (template not edited) |
   | empty string (`VITE_NUTRIENT_LICENSE_KEY=`) | allow with loud TRIAL banner |
   | real value | silent pass |

   The empty-string case is the explicit opt-out: it differs from the
   placeholder so it can only be reached on purpose. Runs first so a
   misconfigured shell doesn't waste time on tsc/vite before failing.
   The script never prints the resolved value, only the
   classification — secrets stay out of CI logs.
2. **Typecheck both targets** — `tsc --noEmit -p tsconfig.server.json`
   then `tsc --noEmit -p tsconfig.viewer.json`. The viewer tsconfig
   excludes `node:*` types; the server tsconfig is strict mode with
   `noUncheckedIndexedAccess`.
3. **Vite (HTML target)** — `INPUT=src/viewer/index.html vite build`,
   then move `dist/src/viewer/index.html` to `dist/mcp-app.html` and
   remove the now-empty `dist/src` tree. `vite-plugin-singlefile`
   inlines the viewer JS / CSS so the iframe loads under a strict
   CSP. `vite.config.ts` aliases `@nutrient-sdk/viewer` to a tiny
   shim so the 3–8 MB SDK bundle is excluded from the HTML output —
   the SDK is loaded from the CDN at runtime instead. The build
   stamps `<meta name="nutrient-sdk-source" content="cdn">` into the
   HTML head as a debug sentinel; `verify-dist.mjs` checks for it to
   gate against accidental SDK re-inlining.
4. **esbuild (server target)** — `node scripts/build-server.mjs`.
   Reads `node_modules/@nutrient-sdk/viewer/package.json#version` and
   inlines it into `dist/index.js` via `define:
   { __NUTRIENT_SDK_VERSION__: '"<version>"' }`. The inlined version
   is what `app-resource.ts` uses to build the version-pinned Nutrient
   CDN base URL the iframe loads SDK assets from.
5. **`verify-dist.mjs`** — sanity-checks that `dist/index.js` and
   `dist/mcp-app.html` exist and that the HTML carries the CDN
   sentinel meta.
6. **`verify-versions.mjs`** — asserts `package.json#version` matches
   `manifest.json#version`.
7. **`verify-server-name.mjs`** — asserts the MCP server name in
   `dist/index.js` matches `manifest.json#display_name`.
8. **`build:mcpb`** — `node scripts/build-mcpb.mjs` stages
   `dist/{index.js, mcp-app.html}` under a `server/` subdirectory and
   invokes `npx @anthropic-ai/mcpb pack` to produce
   `build/nutrient-pdf-editor-mcp-<version>.mcpb`.

Step 3 must run with `emptyOutDir: false` for any later Vite step in a
hot-reload variant; step 4 must run after `npm install` because the
SDK version is read from `node_modules/@nutrient-sdk/viewer/package.json`
at bundle time.

## MCPB bundle

`build/nutrient-pdf-editor-mcp-<version>.mcpb` is the MCPB v0.3
distribution format, built via `@anthropic-ai/mcpb pack`. The `.mcpb`
installs into Claude Desktop (the install host); the iframe viewer
only renders inside Claude Cowork's local-agent-mode (the runtime
that exposes the MCP Apps `io.modelcontextprotocol/ui` capability and
hands the iframe a CSP / `containerDimensions` context). Layout:

```
./
├── manifest.json               # MCPB v0.3, server.type=node
└── server/
    ├── index.js                # staged from dist/
    └── mcp-app.html            # staged from dist/ (CDN flavour, ~352 KB)
```

The `.mcpb` does not ship `node_modules/`, so the SDK version must
be inlined into `dist/index.js` at build time (esbuild `define`).
The host runtime strips `NUTRIENT_SHARED_STATE` from the env, so
the manifest forces it on via
`manifest.json#mcp_config.env.NUTRIENT_SHARED_STATE = "1"` to keep
the multi-process workaround active.

## Version pinning

`package.json#version` is the single source of truth for the
distribution version. `scripts/verify-versions.mjs` checks that
`manifest.json#version` matches and fails the build on drift.

The Nutrient SDK version is pinned via
`dependencies["@nutrient-sdk/viewer"]` and inlined into
`dist/index.js` at build time via esbuild's `define` (sourced from
`node_modules/@nutrient-sdk/viewer/package.json#version`). The inlined
version is used to build the version-pinned CDN URL the iframe loads
the SDK script bundle and runtime assets from.

## SDK upgrade procedure

SDK bumps require `npm install` + rebuild so
`__NUTRIENT_SDK_VERSION__` is re-inlined into `dist/index.js`. The CDN
must already publish the new version — only exact-version paths
return 200, unreleased ones 403. Verify by

```sh
curl -I https://cdn.cloud.nutrient.io/pspdfkit-web@<version>/nutrient-viewer.js
```

before bumping. After updating `package.json#dependencies["@nutrient-sdk/viewer"]`
and running `npm install`, run **`npm run build`** to re-inline
`__NUTRIENT_SDK_VERSION__` into `dist/index.js` (the esbuild `define`
reads the installed SDK's `package.json#version` at build time — a
stale `dist/` will serve the old version to the iframe regardless of
what `node_modules/` contains).
