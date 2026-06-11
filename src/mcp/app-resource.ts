import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { log } from "./logger.js";
import { resolveHostAppName } from "./host-mapping.js";

// Stable URI so every tool that renders the viewer can reference the same resource.
export const VIEWER_RESOURCE_URI = "ui://nutrient-viewer/mcp-app.html";

/**
 * Public Nutrient CDN origin that hosts the Web SDK runtime assets.
 * Already covered by the `https://*.nutrient.io` wildcard in
 * NUTRIENT_VIEWER_DOMAIN_PATTERNS — listed explicitly so the CSP arrays
 * keep the historical `[assetOrigin, ...wildcards]` shape.
 */
export const NUTRIENT_CDN_ORIGIN = "https://cdn.cloud.nutrient.io";

/**
 * Default renewal URL for the Nutrient PDF Editor license.
 * Used when NUTRIENT_RENEWAL_URL environment variable is not set or empty.
 */
export const DEFAULT_RENEWAL_URL = "https://nutrient.io/claude-desktop";

/**
 * Returns the version-pinned Nutrient CDN base URL the embedded Viewer
 * passes to `NutrientSDK.load({ baseUrl })`. The version segment is inlined
 * at build time by esbuild's `define` (see scripts/build-server.mjs) from
 * `node_modules/@nutrient-sdk/viewer/package.json#version` — the .mcpb
 * distribution does not ship node_modules, so we cannot resolve it at
 * runtime there.
 *
 * Trailing slash is required by NutrientSDK.load.
 */
export function getViewerCdnBaseUrl(): string {
  const version =
    typeof globalThis !== "undefined"
      ? (globalThis as { __NUTRIENT_SDK_VERSION__?: string }).__NUTRIENT_SDK_VERSION__
      : undefined;
  if (!version) {
    throw new Error(
      "__NUTRIENT_SDK_VERSION__ is not defined. The build pipeline must inline " +
        "this constant via esbuild `define` (see scripts/build-server.mjs); tests " +
        "must set globalThis.__NUTRIENT_SDK_VERSION__ before importing this module."
    );
  }
  return `${NUTRIENT_CDN_ORIGIN}/pspdfkit-web@${version}/`;
}

/**
 * Wildcard domain patterns covering every Nutrient-controlled host the
 * embedded Viewer SDK contacts. See docs/csp-allowlist.md for rationale,
 * bounded scope, and the empirical-test recipe.
 *
 * KEEP IN SYNC with both _meta.ui.csp declaration sites in this file
 * AND with tests/mcp/app-resource.test.ts.
 */
export const NUTRIENT_VIEWER_DOMAIN_PATTERNS = [
  "https://*.nutrient.io",
  "https://*.nutrient-powered.io"
] as const;

export function buildCsp(assetOrigin: string) {
  return {
    connectDomains: [assetOrigin, ...NUTRIENT_VIEWER_DOMAIN_PATTERNS],
    resourceDomains: [assetOrigin, ...NUTRIENT_VIEWER_DOMAIN_PATTERNS]
  };
}

function findMcpAppHtmlPath(): string {
  const candidates: string[] = [
    process.env.NUTRIENT_VIEWER_LIB_DIR,
    path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname)),
    path.resolve(process.cwd(), "dist")
  ].filter((p): p is string => !!p);

  for (const dir of candidates) {
    const html = path.join(dir, "mcp-app.html");
    if (fs.existsSync(html)) return html;
  }
  throw new Error(`mcp-app.html not found. Searched: ${candidates.join(", ")}`);
}

/**
 * Resolves the renewal URL from the NUTRIENT_RENEWAL_URL environment variable.
 * Returns the env value trimmed of leading/trailing whitespace if set and non-empty;
 * otherwise returns DEFAULT_RENEWAL_URL.
 *
 * Empty strings and whitespace-only values are treated as unset, never as literal values.
 * This function reads process.env lazily so tests can mutate it per-case without reloading.
 */
export function getRenewalUrl(): string {
  const raw = process.env.NUTRIENT_RENEWAL_URL;
  if (typeof raw !== "string") return DEFAULT_RENEWAL_URL;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_RENEWAL_URL;
}

export function registerViewerAppResource(server: McpServer): void {
  registerAppResource(
    server,
    "Nutrient PDF Editor",
    VIEWER_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: { ui: { csp: buildCsp(NUTRIENT_CDN_ORIGIN) } } },
    async () => {
      const assetBaseUrl = getViewerCdnBaseUrl();
      const htmlPath = findMcpAppHtmlPath();
      // Resolve the host application identity from the MCP `clientInfo`
      // captured at the `initialize` handshake. When the host is recognised,
      // this becomes the SDK's `appName`; null when the host is unknown
      // (the viewer then omits `appName`).
      const clientInfo = server.server.getClientVersion();
      const appName = resolveHostAppName(clientInfo);
      log("info", "viewer.resource.read", {
        uri: VIEWER_RESOURCE_URI,
        assetBaseUrl,
        htmlPath,
        clientName: clientInfo?.name,
        resolvedAppName: appName
      });
      const rawHtml = await fs.promises.readFile(htmlPath, "utf-8");
      // The build always emits the CDN flavour: the SDK is not bundled into
      // mcp-app.html, so the viewer expects globalThis.NutrientViewer to be
      // populated before its module runs. We prepend two <script> blocks:
      //   1. A blocking <script src="${sdkUrl}"> that loads the UMD bundle
      //      from the version-pinned CDN origin (covered by CSP via
      //      buildCsp(NUTRIENT_CDN_ORIGIN)). nutrient-viewer.js is the UMD
      //      filename at the CDN root.
      //   2. An inline <script> defining the globals src/viewer/main.ts
      //      reads at module load:
      //        - __NUTRIENT_ASSET_BASE__: where the SDK fetches worker/wasm
      //          assets (public Nutrient CDN, version-pinned).
      //        - __NUTRIENT_APP_NAME__: host identifier passed to
      //          NutrientSDK.load({ appName }). null when the host is
      //          unrecognised — viewer code skips appName in that case.
      //        - __NUTRIENT_RENEWAL_URL__: license-expiry renewal link.
      // vite-plugin-singlefile strips inline <script> tags from the source
      // HTML, so the inline globals must be prepended at serve time.
      const sdkUrl = `${assetBaseUrl}nutrient-viewer.js`;
      log("info", "viewer.resource.cdnSdk", { sdkUrl });
      const injection =
        `<script src="${sdkUrl}"></script>\n` +
        `<script>` +
        `window.__NUTRIENT_ASSET_BASE__ = ${JSON.stringify(assetBaseUrl)};` +
        `window.__NUTRIENT_APP_NAME__ = ${JSON.stringify(appName)};` +
        `window.__NUTRIENT_RENEWAL_URL__ = ${JSON.stringify(getRenewalUrl())};` +
        `</script>\n`;
      const html = injection + rawHtml;
      return {
        contents: [
          {
            uri: VIEWER_RESOURCE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { csp: buildCsp(NUTRIENT_CDN_ORIGIN) } }
          }
        ]
      };
    }
  );
}
