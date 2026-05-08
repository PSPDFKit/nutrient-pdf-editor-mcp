import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Inline the SDK version that the bundled server gets via esbuild `define`.
// app-resource throws at `getViewerCdnBaseUrl()` time if this isn't set.
(globalThis as { __NUTRIENT_SDK_VERSION__?: string }).__NUTRIENT_SDK_VERSION__ = "9.9.9";

// Import after the global is set.
import {
  registerViewerAppResource,
  VIEWER_RESOURCE_URI,
  buildCsp,
  NUTRIENT_VIEWER_DOMAIN_PATTERNS,
  NUTRIENT_CDN_ORIGIN,
  getRenewalUrl,
  DEFAULT_RENEWAL_URL
} from "../../src/mcp/app-resource.js";

const ASSET_ORIGIN = NUTRIENT_CDN_ORIGIN;
const EXPECTED_ASSET_BASE_URL = "https://cdn.cloud.nutrient.io/pspdfkit-web@9.9.9/";

describe("viewer app resource CSP allowlist", () => {
  let tempDir: string;
  let originalLibDir: string | undefined;

  beforeEach(() => {
    // Materialise a stub mcp-app.html so findMcpAppHtmlPath() resolves.
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nutrient-pdf-editor-csp-")
    );
    fs.writeFileSync(
      path.join(tempDir, "mcp-app.html"),
      "<html><body>stub</body></html>"
    );
    originalLibDir = process.env["NUTRIENT_VIEWER_LIB_DIR"];
    process.env["NUTRIENT_VIEWER_LIB_DIR"] = tempDir;
  });

  afterEach(() => {
    if (originalLibDir === undefined) {
      delete process.env["NUTRIENT_VIEWER_LIB_DIR"];
    } else {
      process.env["NUTRIENT_VIEWER_LIB_DIR"] = originalLibDir;
    }
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  describe("NUTRIENT_VIEWER_DOMAIN_PATTERNS", () => {
    it("(e) contains the two named wildcard patterns", () => {
      expect(NUTRIENT_VIEWER_DOMAIN_PATTERNS).toContain("https://*.nutrient.io");
      expect(NUTRIENT_VIEWER_DOMAIN_PATTERNS).toContain("https://*.nutrient-powered.io");
    });
  });

  describe("buildCsp helper", () => {
    it("returns connectDomains and resourceDomains beginning with assetOrigin followed by the named patterns", () => {
      const csp = buildCsp("http://127.0.0.1:12345");
      expect(csp.connectDomains).toEqual([
        "http://127.0.0.1:12345",
        "https://*.nutrient.io",
        "https://*.nutrient-powered.io"
      ]);
      expect(csp.resourceDomains).toEqual([
        "http://127.0.0.1:12345",
        "https://*.nutrient.io",
        "https://*.nutrient-powered.io"
      ]);
    });
  });

  describe("registerViewerAppResource", () => {
    it("(a) registration metadata has the correct CSP shape", () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { resources: {} } }
      );
      registerViewerAppResource(server);

      const registered = (server as any)._registeredResources[
        VIEWER_RESOURCE_URI
      ];
      const csp = registered.metadata._meta.ui.csp;

      expect(csp.connectDomains).toEqual([
        ASSET_ORIGIN,
        "https://*.nutrient.io",
        "https://*.nutrient-powered.io"
      ]);
      expect(csp.resourceDomains).toEqual([
        ASSET_ORIGIN,
        "https://*.nutrient.io",
        "https://*.nutrient-powered.io"
      ]);
    });

    it("(b) resources/read content item has the correct CSP shape", async () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { resources: {} } }
      );
      registerViewerAppResource(server);

      const registered = (server as any)._registeredResources[
        VIEWER_RESOURCE_URI
      ];
      const result = await registered.readCallback(
        new URL(VIEWER_RESOURCE_URI),
        {}
      );
      const csp = result.contents[0]._meta.ui.csp;

      expect(csp.connectDomains).toEqual([
        ASSET_ORIGIN,
        "https://*.nutrient.io",
        "https://*.nutrient-powered.io"
      ]);
      expect(csp.resourceDomains).toEqual([
        ASSET_ORIGIN,
        "https://*.nutrient.io",
        "https://*.nutrient-powered.io"
      ]);
    });

    it("(c) lockstep — registration metadata and content item CSP are equal", async () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { resources: {} } }
      );
      registerViewerAppResource(server);

      const registered = (server as any)._registeredResources[
        VIEWER_RESOURCE_URI
      ];
      const metaCsp = registered.metadata._meta.ui.csp;

      const result = await registered.readCallback(
        new URL(VIEWER_RESOURCE_URI),
        {}
      );
      const itemCsp = result.contents[0]._meta.ui.csp;

      expect(metaCsp.connectDomains).toEqual(itemCsp.connectDomains);
      expect(metaCsp.resourceDomains).toEqual(itemCsp.resourceDomains);
    });

    it("(d) bounded wildcard scope — no bare * or https://* in either site", async () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { resources: {} } }
      );
      registerViewerAppResource(server);

      const registered = (server as any)._registeredResources[
        VIEWER_RESOURCE_URI
      ];
      const metaCsp = registered.metadata._meta.ui.csp;
      const result = await registered.readCallback(
        new URL(VIEWER_RESOURCE_URI),
        {}
      );
      const itemCsp = result.contents[0]._meta.ui.csp;

      for (const csp of [metaCsp, itemCsp]) {
        for (const domains of [csp.connectDomains, csp.resourceDomains]) {
          for (const entry of domains) {
            expect(entry).not.toBe("*");
            expect(entry).not.toMatch(/^https:\/\/\*$/);
            // Non-assetOrigin entries must be bounded to Nutrient domain families.
            if (entry !== ASSET_ORIGIN) {
              expect(entry).toMatch(/^https:\/\/\*\.nutrient/);
            }
          }
        }
      }
    });

    it("(f) HTML injection sets __NUTRIENT_ASSET_BASE__ to the version-pinned CDN URL with trailing slash", async () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { resources: {} } }
      );
      registerViewerAppResource(server);

      const registered = (server as any)._registeredResources[
        VIEWER_RESOURCE_URI
      ];
      const result = await registered.readCallback(
        new URL(VIEWER_RESOURCE_URI),
        {}
      );
      const html = result.contents[0].text as string;

      expect(html).toContain(
        `window.__NUTRIENT_ASSET_BASE__ = "${EXPECTED_ASSET_BASE_URL}";`
      );
      expect(html).toContain(`window.__NUTRIENT_APP_NAME__ = `);
      // Sanity: no leftover localhost asset-server URL.
      expect(html).not.toMatch(/127\.0\.0\.1/);
      expect(html).not.toMatch(/localhost:\d+/);
    });

    it("(e) named Nutrient wildcard patterns present in both registration and content-item arrays", async () => {
      const server = new McpServer(
        { name: "test", version: "0.1.0" },
        { capabilities: { resources: {} } }
      );
      registerViewerAppResource(server);

      const registered = (server as any)._registeredResources[
        VIEWER_RESOURCE_URI
      ];
      const metaCsp = registered.metadata._meta.ui.csp;
      const result = await registered.readCallback(
        new URL(VIEWER_RESOURCE_URI),
        {}
      );
      const itemCsp = result.contents[0]._meta.ui.csp;

      for (const csp of [metaCsp, itemCsp]) {
        expect(csp.connectDomains).toContain("https://*.nutrient.io");
        expect(csp.connectDomains).toContain("https://*.nutrient-powered.io");
        expect(csp.resourceDomains).toContain("https://*.nutrient.io");
        expect(csp.resourceDomains).toContain("https://*.nutrient-powered.io");
      }
    });
  });
});

describe("getRenewalUrl", () => {
  let originalRenewalUrl: string | undefined;

  beforeEach(() => {
    originalRenewalUrl = process.env["NUTRIENT_RENEWAL_URL"];
  });

  afterEach(() => {
    if (originalRenewalUrl === undefined) {
      delete process.env["NUTRIENT_RENEWAL_URL"];
    } else {
      process.env["NUTRIENT_RENEWAL_URL"] = originalRenewalUrl;
    }
  });

  it("AC3.1: with NUTRIENT_RENEWAL_URL unset, returns DEFAULT_RENEWAL_URL", () => {
    delete process.env["NUTRIENT_RENEWAL_URL"];
    expect(getRenewalUrl()).toBe(DEFAULT_RENEWAL_URL);
  });

  it("AC3.2: with NUTRIENT_RENEWAL_URL set to a custom URL, returns it verbatim", () => {
    process.env["NUTRIENT_RENEWAL_URL"] = "https://example.com/renew";
    expect(getRenewalUrl()).toBe("https://example.com/renew");
  });

  it("AC3.3 (empty): with NUTRIENT_RENEWAL_URL set to empty string, returns DEFAULT_RENEWAL_URL", () => {
    process.env["NUTRIENT_RENEWAL_URL"] = "";
    expect(getRenewalUrl()).toBe(DEFAULT_RENEWAL_URL);
  });

  it("AC3.3 (whitespace): with NUTRIENT_RENEWAL_URL set to whitespace only, returns DEFAULT_RENEWAL_URL", () => {
    process.env["NUTRIENT_RENEWAL_URL"] = "   ";
    expect(getRenewalUrl()).toBe(DEFAULT_RENEWAL_URL);
  });

  it("AC3.4: with NUTRIENT_RENEWAL_URL set to a URL with leading/trailing whitespace, trims and returns the trimmed value", () => {
    process.env["NUTRIENT_RENEWAL_URL"] = " https://x.com ";
    expect(getRenewalUrl()).toBe("https://x.com");
  });
});

describe("__NUTRIENT_RENEWAL_URL__ injection", () => {
  let tempDir: string;
  let originalLibDir: string | undefined;
  let originalRenewalUrl: string | undefined;

  beforeEach(() => {
    // Setup temp directory for mcp-app.html
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nutrient-pdf-editor-renewal-")
    );
    fs.writeFileSync(
      path.join(tempDir, "mcp-app.html"),
      "<html><body>stub</body></html>"
    );
    originalLibDir = process.env["NUTRIENT_VIEWER_LIB_DIR"];
    process.env["NUTRIENT_VIEWER_LIB_DIR"] = tempDir;

    // Save renewal URL for restoration
    originalRenewalUrl = process.env["NUTRIENT_RENEWAL_URL"];
  });

  afterEach(() => {
    // Restore lib dir
    if (originalLibDir === undefined) {
      delete process.env["NUTRIENT_VIEWER_LIB_DIR"];
    } else {
      process.env["NUTRIENT_VIEWER_LIB_DIR"] = originalLibDir;
    }

    // Restore renewal URL
    if (originalRenewalUrl === undefined) {
      delete process.env["NUTRIENT_RENEWAL_URL"];
    } else {
      process.env["NUTRIENT_RENEWAL_URL"] = originalRenewalUrl;
    }

    // Cleanup temp directory
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it("AC3.2: injected HTML contains __NUTRIENT_RENEWAL_URL__ global with the resolved URL", async () => {
    process.env["NUTRIENT_RENEWAL_URL"] = "https://example.com/renew";

    const server = new McpServer(
      { name: "test", version: "0.1.0" },
      { capabilities: { resources: {} } }
    );
    registerViewerAppResource(server);

    const registered = (server as any)._registeredResources[VIEWER_RESOURCE_URI];
    const result = await registered.readCallback(
      new URL(VIEWER_RESOURCE_URI),
      {}
    );
    const html = result.contents[0].text as string;

    expect(html).toContain('window.__NUTRIENT_RENEWAL_URL__ = "https://example.com/renew";');
    expect(html).not.toContain("__NUTRIENT_RENEWAL_URL__ = undefined");
  });
});
