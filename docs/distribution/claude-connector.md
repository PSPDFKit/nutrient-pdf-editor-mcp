# Distribution: Claude Connector

The Nutrient PDF Editor ships as a **Claude Connector distributed as an `.mcpb` bundle** that Claude Desktop installs and runs locally over stdio. Cowork — the surface that runs inside Claude Desktop — is what renders the embedded viewer iframe; the server itself never speaks HTTP.

## What this Connector is

In Anthropic's terminology a Connector is any MCP server a user adds to Claude. Anthropic supports two transports for Connectors:

- **Streamable HTTP** — a remote MCP server reachable at a public URL.
- **stdio** — a local subprocess, packaged as an `.mcpb` bundle and installed into Claude Desktop.

This server uses the **stdio** path. `src/mcp/index.ts` only constructs a `StdioServerTransport`; passing anything other than `--stdio` exits with an error. There is no Streamable HTTP endpoint, no remote deployment, and no public URL to register.

## Where it runs

| Surface | Supported? | Why |
|---|---|---|
| Claude Desktop with Cowork | ✓ | Installs the `.mcpb`, runs the server as a stdio subprocess, and Cowork renders the MCP App iframe viewer inside the chat surface. |
| Claude Desktop chat (no Cowork) | ✗ | The `require-ui-capability` gate fails at `initialize` — the host does not advertise the `io.modelcontextprotocol/ui` extension, so the viewer iframe cannot be mounted and tool calls would time out with `VIEWER_TIMEOUT_MS`. |
| claude.ai (web) | ✗ | The web surface cannot run a local stdio subprocess and does not host Cowork's iframe surface. |
| Claude mobile apps | ✗ | Same reason as claude.ai: no local subprocess host, no MCP App rendering surface. |

The viewer iframe is the entire point of the server. Cowork inside Claude Desktop is the only surface where it renders today, so it is the only supported runtime.

## End-user install

1. In Claude Desktop, open Settings → Extensions → Browse extensions and search for **Nutrient PDF Editor**.
2. Install it from the directory. Claude Desktop runs the bundled server locally over stdio and keeps directory installs up to date as new versions are published.
3. Use the editor inside a Cowork chat in Claude Desktop. Tools register with the bare names defined in [`tool-surface.md`](../tool-surface.md).

Developers can build the bundle locally via `npm run build` (output lands in `build/nutrient-pdf-editor-mcp-<version>.mcpb`) and install it by double-clicking the file. Local builds without a license key run the viewer in watermarked trial mode.

## How releases ship

New versions are submitted to Anthropic for review and published through the Claude Connector directory; the [Build release bundle workflow](../../.github/workflows/release.yml) produces the submission `.mcpb` on tag push. GitHub Releases are no longer published — the historical releases remain available for reference only.

## See also

- [`require-ui-capability.ts`](../../src/mcp/require-ui-capability.ts) — the `initialize`-time gate that rejects hosts which don't advertise the MCP App UI extension.
- [`build-and-distribution.md`](../build-and-distribution.md) — how the `.mcpb` is built and what it contains.
- [`document-bytes-design.md`](../document-bytes-design.md) — how document bytes flow over the stdio bridge.
- [`csp-allowlist.md`](../csp-allowlist.md) — the iframe CSP that the embedded Cowork viewer enforces.
- [`bridge-protocol.md`](../bridge-protocol.md) — the iframe-to-server wire protocol that runs on top of the stdio transport.
