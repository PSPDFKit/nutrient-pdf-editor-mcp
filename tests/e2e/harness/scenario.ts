import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { createMcpClient, type ElicitRule, type McpHarnessClient } from "./mcp-client.js";

// Resolve the installed Nutrient SDK version so the harness can point the
// in-iframe loader at the same version-pinned CDN bundle that production
// uses (server-side: src/mcp/app-resource.ts#getViewerCdnBaseUrl, which
// inlines the version at build time). E2E mode skips that build-time
// inject path entirely; reading package.json keeps the harness in lockstep
// with whatever version `npm install` resolved without a manual update.
const requireFromHere = createRequire(import.meta.url);
const SDK_VERSION = (requireFromHere("@nutrient-sdk/viewer/package.json") as { version: string }).version;
const VIEWER_CDN_BASE_URL = `https://cdn.cloud.nutrient.io/pspdfkit-web@${SDK_VERSION}/`;

// Production no longer ships a local asset server (assets come from the
// Nutrient CDN at runtime — see src/mcp/app-resource.ts). The e2e harness
// still needs a real http origin so Playwright can navigate to mcp-app.html
// and so the inlined viewer JS can resolve relative URLs sanely. We spin up
// a tiny static server in test code only, scoped to the scenario lifetime.
function startHarnessServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const distDir = path.resolve("dist");
    const htmlPath = path.join(distDir, "mcp-app.html");
    if (!fs.existsSync(htmlPath)) {
      reject(new Error(`harness server: ${htmlPath} not found — run \`npm run build\` first.`));
      return;
    }
    const server = http.createServer((req, res) => {
      if (req.url === "/mcp-app.html" || req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(htmlPath));
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())))
      });
    });
    server.on("error", reject);
  });
}

export interface ScenarioContext {
  client: McpHarnessClient;
  page: Page;
  seedViewer: () => Promise<{ viewUUID: string }>;
  /**
   * Per-scenario temp directory, advertised to the MCP server as an extra
   * root. Cleared at scenario teardown. Use `copyFixture` to deposit
   * mutable copies of repo fixtures here so destructive ops
   * (apply_redactions, form-field updates that flush via auto-save, etc.)
   * never dirty the tracked PDFs.
   */
  tmpDir: string;
  /**
   * Copy a fixture into the scenario's tmp dir under its original basename
   * and return the new absolute path. Subsequent `open_document` calls
   * against this path are safe to mutate. Throws if the source is missing.
   */
  copyFixture: (absSourcePath: string) => Promise<string>;
}

export interface ScenarioOptions {
  env?: Record<string, string>;
  /** Filesystem roots advertised to the server via `roots/list`. */
  roots?: string[];
  elicitation?: ElicitRule;
  headless?: boolean;
}

export async function withScenario(
  opts: ScenarioOptions,
  body: (ctx: ScenarioContext) => Promise<void>
): Promise<void> {
  const harness = await startHarnessServer();
  const VIEWER_PAGE_URL = `${harness.url}/mcp-app.html`;
  // Per-scenario tmp dir for fixture copies. Always advertised as a root so
  // `copyFixture` outputs are immediately openable; harmless when unused.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nutrient-e2e-"));
  const advertisedRoots = [...(opts.roots ?? []), tmpDir];
  const client = await createMcpClient({ env: opts.env ?? {}, roots: advertisedRoots });
  if (opts.elicitation) client.setElicitationRule(opts.elicitation);

  const copyFixture = async (absSourcePath: string): Promise<string> => {
    const dest = path.join(tmpDir, path.basename(absSourcePath));
    await fs.promises.copyFile(absSourcePath, dest);
    return dest;
  };

  const headless = opts.headless ?? process.env.DEBUG_E2E !== "1";
  const browser: Browser = await chromium.launch({ headless });
  const page = await browser.newPage();

  page.on("console", (msg) => {
    // eslint-disable-next-line no-console
    console.error(`[page.${msg.type()}]`, msg.text());
  });
  page.on("pageerror", (err) => {
    // eslint-disable-next-line no-console
    console.error("[pageerror]", err.message);
  });

  await page.addInitScript(
    ({ assetBase }) => {
      (window as unknown as { __E2E_TEST: boolean }).__E2E_TEST = true;
      // Real, version-pinned CDN URL. The viewer is not mocked: NutrientSDK.load()
      // actually fetches WASM/worker chunks at runtime, so this URL must
      // resolve. Production injects the same shape from
      // src/mcp/app-resource.ts#getViewerCdnBaseUrl (build-time inline).
      // Tests therefore require network access to cdn.cloud.nutrient.io.
      (window as unknown as { __NUTRIENT_ASSET_BASE__: string }).__NUTRIENT_ASSET_BASE__ =
        assetBase;
      // Empty string forces the SDK into trial mode for e2e.
      (window as unknown as { __NUTRIENT_LICENSE_KEY__: string }).__NUTRIENT_LICENSE_KEY__ = "";
    },
    { assetBase: VIEWER_CDN_BASE_URL }
  );

  await page.exposeFunction(
    "__mcpCallTool",
    async (name: string, args: Record<string, unknown>) => {
      return client.callTool(name, args);
    }
  );

  // The viewer's `openDocumentFromPath` (src/viewer/main.ts) calls
  // `app.readServerResource({ uri })` to fetch document bytes. Production
  // routes this over the MCP Apps RPC channel that `app.connect()` brings
  // up; in E2E mode we skip `connect()` entirely and stub
  // `app.callServerTool` for tool calls. Without a parallel stub for
  // `readServerResource`, ext-apps>=1.7.1 throws "Not connected" because
  // it gates resource reads on a completed connect handshake. Route the
  // call through the MCP client just like callTool — same pattern, same
  // host-side authority, no fake connect dance.
  await page.exposeFunction("__mcpReadResource", async (uri: string) => {
    return client.readResource(uri);
  });

  try {
    // dist/mcp-app.html is a self-contained HTML document with the viewer JS
    // inlined by vite-plugin-singlefile. We navigate to it via the harness's
    // tiny static server. In production the host injects __NUTRIENT_ASSET_BASE__
    // via the resources/read response; the harness sets it via addInitScript
    // above to a sentinel CDN URL (the SDK boundary is mocked in e2e).
    await page.goto(VIEWER_PAGE_URL, { waitUntil: "load" });
    await page.waitForFunction(
      () => typeof (window as unknown as { __app?: unknown }).__app !== "undefined",
      { timeout: 15_000 }
    );

    await page.evaluate(() => {
      const app = (window as unknown as {
        __app: {
          callServerTool: (req: { name: string; arguments: Record<string, unknown> }) => unknown;
          readServerResource: (req: { uri: string }) => unknown;
        };
      }).__app;
      app.callServerTool = async (req) => {
        return (window as unknown as {
          __mcpCallTool: (n: string, a: Record<string, unknown>) => Promise<unknown>;
        }).__mcpCallTool(req.name, req.arguments);
      };
      app.readServerResource = async (req) => {
        return (window as unknown as {
          __mcpReadResource: (u: string) => Promise<unknown>;
        }).__mcpReadResource(req.uri);
      };
    });

    // Auto-forward every model-side tool result to the iframe via
    // `app.ontoolresult`. Cowork does this in production; without it, the
    // viewer never sees `structuredContent.documentPath` from open_document
    // and the SDK never mounts. Wrapping callTool keeps tests free of
    // boilerplate replay logic.
    const rawCallTool = client.callTool;
    client.callTool = async (name, args) => {
      const result = await rawCallTool(name, args);
      await page.evaluate((r) => {
        const app = (window as unknown as {
          __app: { ontoolresult?: (r: unknown) => void };
        }).__app;
        app.ontoolresult?.(r);
      }, result);
      return result;
    };

    const seedViewer = async (): Promise<{ viewUUID: string }> => {
      // `close_document` pre-open is an idempotent no-op that returns
      // `_meta.viewUUID` without enqueueing anything for the iframe. We use
      // it as the viewUUID seed because the prior `ping` tool was removed
      // from the public surface — close_document is the only other tool that
      // is exempt from the requireOpenDocument guard.
      const seedResult = (await client.callTool("close_document", {})) as {
        _meta?: { viewUUID?: string };
      };
      const viewUUID = seedResult._meta?.viewUUID;
      if (!viewUUID) throw new Error("close_document result missing _meta.viewUUID");

      await page.evaluate((result) => {
        const app = (window as unknown as {
          __app: { ontoolresult?: (r: unknown) => void };
        }).__app;
        app.ontoolresult?.(result);
      }, seedResult);

      return { viewUUID };
    };

    await body({ client, page, seedViewer, tmpDir, copyFixture });
  } finally {
    await browser.close();
    await client.close();
    await harness.close();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}
