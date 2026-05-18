import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * The Nutrient SDK is NOT bundled into mcp-app.html. Instead,
 * app-resource.ts injects a blocking `<script src="...">` that loads the
 * UMD bundle from `__NUTRIENT_ASSET_BASE__` at runtime, exposing
 * `globalThis.NutrientViewer`. A resolve alias maps the
 * `import("@nutrient-sdk/viewer")` call in main.ts to a tiny shim that
 * reads that global — so the 3–8 MB SDK is excluded from the HTML bundle.
 *
 * Trade-off: ~6.5 MB removed from mcp-app.html, paid back as a
 * ~200–500 ms first-load CDN fetch with indefinite browser-cache hits
 * thereafter. Offline use is not supported.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the CDN shim file (written at config load time).
const CDN_SHIM_PATH = path.join(__dirname, "src", "viewer", "nutrient-sdk-cdn-shim.js");

// Write the shim synchronously so it's present when Vite resolves the alias.
// The UMD bundle sets globalThis.NutrientViewer; the shim re-exports it as
// the default export, matching the ESM shape main.ts expects.
fs.writeFileSync(CDN_SHIM_PATH, "export default globalThis.NutrientViewer;\n");

/**
 * Plugin that injects a <meta name="nutrient-sdk-source" content="cdn"> tag
 * into the built HTML for human-debug visibility (and for the verify-dist
 * smoke check that gates against accidental SDK re-inlining).
 */
function nutrientCdnMetaPlugin(): Plugin {
  return {
    name: "nutrient-cdn-meta",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n<meta name="nutrient-sdk-source" content="cdn">`
      );
    },
  };
}

export default defineConfig({
  plugins: [nutrientCdnMetaPlugin(), viteSingleFile()],
  resolve: {
    // Alias the SDK to the tiny shim so Vite/Rollup never sees the real
    // 3–8 MB SDK bundle. The alias runs before optimizeDeps pre-bundling,
    // making it the most reliable interception point.
    alias: { "@nutrient-sdk/viewer": CDN_SHIM_PATH }
  },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    rollupOptions: {
      input: process.env.INPUT || "src/viewer/index.html",
      output: {
        inlineDynamicImports: true
      }
    }
  },
  // Exclude the SDK from pre-bundling (aliased to the shim).
  optimizeDeps: {
    include: [],
    exclude: ["@nutrient-sdk/viewer"]
  }
});
