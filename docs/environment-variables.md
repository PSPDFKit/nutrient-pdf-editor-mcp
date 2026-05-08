# Environment variables

Last verified: 2026-05-08

Reference for every runtime and build-time environment variable the server and viewer recognise.

## Server-side (`src/mcp/`)

- `VIEWER_TIMEOUT_MS` — per-round-trip timeout for server→viewer tool
  calls (default 30000 ms). Parsed in `src/mcp/bridge.ts`.
- `LONG_POLL_TIMEOUT_MS` — maximum time the server holds an empty
  `poll_commands` request open before returning `{commands: []}` so
  the viewer can reissue (default 25000 ms). Kept under the MCP SDK's
  default request timeout so the host doesn't cancel us first. Tests
  override this to a small value so empty-poll paths return fast.
  Parsed in `src/mcp/bridge.ts`.
- `CLOSE_BROADCAST_TIMEOUT_MS` — how long `open_document` waits for
  each prior-view iframe to ack its broadcast `close_document` command
  (default 2000 ms). Short by design: a dead/unresponsive prior iframe
  should not block the new conversation's open for the full
  `VIEWER_TIMEOUT_MS`. Tests override this to make the timeout path
  fast. Parsed in `src/mcp/tools/open-document.ts`.
- `NUTRIENT_RENEWAL_URL` — URL embedded in the license-expired overlay
  so users can renew (default `https://nutrient.io/claude-desktop`).
  Parsed and injected into `window.__NUTRIENT_RENEWAL_URL__` in
  `src/mcp/app-resource.ts` at resource-read time. The viewer reads it
  from `window.__NUTRIENT_RENEWAL_URL__` with a fallback to
  `DEFAULT_RENEWAL_URL_FALLBACK` in `src/viewer/main.ts`.
- `NUTRIENT_SHARED_STATE` — when set to `"1"`, swaps the in-memory
  session backend for a file-backed one under
  `${TMPDIR}/nutrient-pdf-editor/state.json`. Always-on in `.mcpb`
  distribution via `manifest.json#mcp_config.env`. See
  [`src/mcp/shared-state/README.md`](../src/mcp/shared-state/README.md).

## Viewer-side (`src/viewer/`)

- `window.__NUTRIENT_LICENSE_KEY__` — runtime license key override;
  presence wins, even if empty string (empty forces SDK trial mode,
  used by the e2e harness on `127.0.0.1`). When absent, falls back to
  the build-time `import.meta.env.VITE_NUTRIENT_LICENSE_KEY`.
- `VITE_NUTRIENT_LICENSE_KEY` — build-time license key, baked into
  the viewer bundle via Vite. Overridden at runtime by
  `window.__NUTRIENT_LICENSE_KEY__` if present. **Required for
  production `npm run build`**: `scripts/verify-license-env.mjs` fails
  the build when this var is unset or still matches the
  `<YOUR_LICENSE_KEY_HERE>` placeholder in `.env.example`. Set it to
  an empty string (`VITE_NUTRIENT_LICENSE_KEY=`) to deliberately
  build a trial-mode artefact — the build prints a loud TRIAL banner
  in that case. See [`build-and-distribution.md` §
  "Build pipeline"](build-and-distribution.md#build-pipeline) step 1.
- `window.__NUTRIENT_ASSET_BASE__` — version-pinned Nutrient CDN URL
  injected into the HTML by the server at resource-read time
  (`src/mcp/app-resource.ts`). The viewer passes it as `baseUrl` to
  `NutrientSDK.load`.
- `window.__NUTRIENT_RENEWAL_URL__` — renewal URL injected by the
  server (see `NUTRIENT_RENEWAL_URL` above). Viewer reads it with a
  fallback to `DEFAULT_RENEWAL_URL_FALLBACK`.
- `window.__NUTRIENT_APP_NAME__` — host bundle-identifier injected by
  the server so the SDK can adapt to the electron app name. The
  client→host mapping lives in `src/mcp/host-mapping.ts`.
