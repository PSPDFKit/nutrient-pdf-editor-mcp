/**
 * Initialize-time gate that rejects clients which do not advertise the MCP
 * Apps UI capability.
 *
 * Background: every public tool depends on the embedded Nutrient
 * Web SDK iframe being mounted by the host as an MCP App resource. Without
 * UI rendering there is no viewer, no `viewUUID`, and every tool call fails
 * with a generic `VIEWER_TIMEOUT_MS` timeout that does not explain what is
 * wrong. The MCP Apps spec (`specification/2026-01-26/apps.mdx`) defines a
 * standard extensions-based capability for exactly this case:
 *
 * ```json
 * "capabilities": {
 *   "extensions": {
 *     "io.modelcontextprotocol/ui": {
 *       "mimeTypes": ["text/html;profile=mcp-app"]
 *     }
 *   }
 * }
 * ```
 *
 * On reject, we throw `McpError(InvalidRequest, …)` from inside the
 * `initialize` request handler so the host receives a JSON-RPC error
 * response naming the missing capability and the required mime type — one
 * actionable message instead of N round-trip timeouts.
 *
 * Lenient `experimental` fallback: some hosts may still advertise the
 * capability under `capabilities.experimental[...]` rather than the
 * spec-2026-01-26 `extensions[...]` location. We accept both to avoid
 * locking out a host that has not yet migrated.
 */

import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
  getUiCapability
} from "@modelcontextprotocol/ext-apps/server";
import { ErrorCode, McpError, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";

/**
 * Shape of the MCP Apps client capability object as it appears under either
 * `capabilities.extensions[EXTENSION_ID]` (spec-2026-01-26) or, leniently,
 * `capabilities.experimental[EXTENSION_ID]` (older draft variant some hosts
 * may still emit).
 *
 * `getUiCapability` from `@modelcontextprotocol/ext-apps/server` returns
 * `McpUiClientCapabilities | undefined`; we duplicate the minimal shape here
 * so the experimental-fallback branch — which the helper does not cover —
 * can be type-checked the same way.
 */
type UiCapability = { mimeTypes?: ReadonlyArray<string> };

/**
 * Look the capability up under both `extensions` and `experimental`. Returns
 * `undefined` if neither slot has it.
 *
 * `getUiCapability` only reads the spec-2026-01-26 `extensions` slot; we
 * fall back to `experimental` ourselves so an older host that has not
 * migrated to `extensions` still passes the gate.
 */
export function readUiCapability(
  capabilities:
    | (ClientCapabilities & {
        extensions?: Record<string, unknown>;
      })
    | null
    | undefined
): UiCapability | undefined {
  if (!capabilities) return undefined;

  const extensionsCap = getUiCapability(capabilities) as UiCapability | undefined;
  if (extensionsCap) return extensionsCap;

  const experimental = capabilities.experimental as Record<string, unknown> | undefined;
  const experimentalCap = experimental?.[EXTENSION_ID];
  if (experimentalCap && typeof experimentalCap === "object") {
    return experimentalCap as UiCapability;
  }
  return undefined;
}

const REJECTION_MESSAGE =
  `Nutrient PDF Editor requires an MCP host that supports MCP Apps ` +
  `(${EXTENSION_ID}, ${RESOURCE_MIME_TYPE}). This host did not advertise ` +
  `that capability. Install Nutrient PDF Editor in a host that supports ` +
  `MCP Apps (e.g. Claude Desktop, Claude Code, or Claude Cowork).`;

/**
 * Throws `McpError(InvalidRequest, …)` when the client capability object
 * does not advertise `${EXTENSION_ID}` with `${RESOURCE_MIME_TYPE}` in its
 * `mimeTypes`. The error message names the extension id and the required
 * mime type so a host implementer reading the JSON-RPC error knows exactly
 * what to fix.
 *
 * Returns `void` on success — the actual `InitializeResult` is constructed
 * by delegating to the SDK's default `_oninitialize` body in the calling
 * handler.
 */
export function requireUiCapability(
  capabilities:
    | (ClientCapabilities & {
        extensions?: Record<string, unknown>;
      })
    | null
    | undefined
): void {
  const cap = readUiCapability(capabilities);
  if (!cap) {
    throw new McpError(ErrorCode.InvalidRequest, REJECTION_MESSAGE);
  }
  const mimeTypes = cap.mimeTypes;
  if (!Array.isArray(mimeTypes) || !mimeTypes.includes(RESOURCE_MIME_TYPE)) {
    throw new McpError(ErrorCode.InvalidRequest, REJECTION_MESSAGE);
  }
}
