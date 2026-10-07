# Hosted connector: Nutrient Document Viewer (remote mode)

The same server and viewer as the desktop extension, run as a hosted remote MCP
connector so it works in claude.ai (web), Cowork and Claude Desktop without a local
install. Built for the Salesforce document-generation flow.

## Flow

1. The user asks Claude to generate a document from a Nutrient template for a Salesforce record.
2. Claude calls the Salesforce action **Nutrient: Generate Document** through the Salesforce
   MCP connector (see `docs/claude-generation-action.md` in
   `nutrient-document-solutions-salesforce`, branch `pavitter/experimental-claude-demo`).
3. Salesforce generates the document through DWS, saves it to the record's Files, and returns a
   short-lived download link (`viewerUrl`).
4. Claude calls this connector's `open_document_url` with that link.
5. The server downloads the file once into memory, and the viewer (Web SDK from the Nutrient
   CDN) renders it inline. The user and Claude can then read, annotate, fill and redact it.

## What changed vs. the desktop extension

| Area | Desktop (`--stdio`) | Hosted (`--http`) |
|---|---|---|
| Transport | stdio | Streamable HTTP at `/mcp` (`/healthz` for health checks) |
| Open tool | `open_document` (local path under client roots) | `open_document_url` (HTTPS link) |
| Document bytes | read from disk | downloaded once, kept in memory (2 h TTL) |
| Saves (auto-save) | written back to the file | replace the in-memory copy only; download/print buttons are kept |
| State | process-global (one user) | per MCP session via AsyncLocalStorage; queues keyed by `viewUUID` |
| License | build-time key, desktop `appName` | always trial mode, no `appName` |
| Logs over MCP | yes | no (would mix sessions) |

Code: `src/mcp/http-server.ts`, `src/mcp/remote-documents.ts`,
`src/mcp/tools/open-document-url.ts`, `src/mcp/session.ts` (session contexts), plus small
`remote` branches in `server.ts`, `app-resource.ts`, `document-resource.ts`,
`tools/write-document-bytes.ts` and `src/viewer/main.ts`. Tests: `tests/mcp/remote-mode.test.ts`.

## Run it

```sh
npm ci
npm run build:remote
PORT=8787 npm run start:http      # MCP endpoint: http://localhost:8787/mcp
```

Docker: `docker build -f Dockerfile.remote -t nutrient-viewer-remote .`

## Hosting

Needs one always-on Node 24 process with a public HTTPS URL. Good fits: Render (web
service), Fly.io (one machine), Google Cloud Run (`--min-instances=1 --max-instances=1`,
request timeout at least 60 s), or any VM. Not serverless functions (Vercel/Lambda) and not
more than one instance: the viewer bridge, sessions and documents live in memory.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `NUTRIENT_ALLOWED_DOWNLOAD_HOSTS` | `force.com, salesforce.com, cloudforce.com, salesforce-sites.com, documentforce.com` | Comma-separated host suffixes `open_document_url` may download from (`*.` prefix allowed). Every redirect hop is re-checked |
| `NUTRIENT_REMOTE_DOC_MAX_BYTES` | 50 MB | Download and save size limit |
| `NUTRIENT_REMOTE_DOC_TTL_MS` | 2 h | How long an opened document stays in memory after its last save |
| `NUTRIENT_SKIP_UI_CAPABILITY_CHECK` | unset | Set to `1` to accept clients that do not advertise MCP Apps (debugging only) |

## Add it to Claude

- Single user: Customize > Connectors > Add custom connector > `https://<host>/mcp` (no auth).
- Org: an Owner adds it once as a custom connector, or uploads the plugin in
  `plugin/nutrient-salesforce-docgen/` (set the URL in its `.mcp.json` first). The plugin also
  ships the `nutrient-salesforce-docgen` skill that tells Claude the generate-then-open sequence.

## Known limits (v1)

- **No authentication** on the connector. Documents are only reachable by their unguessable id,
  but anyone with the URL can use the viewer. Add OAuth before production.
- **Edits are not written back to Salesforce.** Next step: Salesforce OAuth on this connector,
  then upload a new ContentVersion on save.
- **The download link is public until it expires** (default 60 minutes, set on the Salesforce side).
- **Session mapping not yet verified on claude.ai**: agent tools rely on the host keeping one MCP
  session per conversation. The viewer's own calls (polling, byte reads, saves) work across
  sessions because they use ids, not session state.
- Trial-mode watermark on documents.
