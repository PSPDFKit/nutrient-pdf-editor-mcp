#!/usr/bin/env node
import { readFileSync } from "node:fs";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const banner = `#!/usr/bin/env node
import { createRequire } from "module"; const require = createRequire(import.meta.url);`;

// Inline the resolved Nutrient SDK version into the bundled server. The .mcpb
// distribution does not ship node_modules/, so we cannot read the SDK package.json
// at runtime — esbuild's `define` substitutes the version literal at build time.
// Source of truth: node_modules/@nutrient-sdk/viewer/package.json#version, which
// matches whatever `npm install` resolved from package.json's `^X.Y.Z` constraint.
const sdkPkg = JSON.parse(
  readFileSync("node_modules/@nutrient-sdk/viewer/package.json", "utf-8")
);

// Inline this bundle's own version so the runtime update check can compare it
// against the latest GitHub release. The .mcpb ships no package.json the server
// can read at runtime. Source of truth: package.json#version (kept in sync with
// manifest.json by verify-versions.mjs).
const ownPkg = JSON.parse(readFileSync("package.json", "utf-8"));

const buildOptions = {
  entryPoints: ["src/mcp/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  banner: {
    js: banner,
  },
  external: ["@nutrient-sdk/viewer"],
  define: {
    "globalThis.__NUTRIENT_SDK_VERSION__": JSON.stringify(sdkPkg.version),
    "globalThis.__NUTRIENT_MCPB_VERSION__": JSON.stringify(ownPkg.version),
  },
};

if (watch) {
  // Watch mode: esbuild context keeps the process alive, rebuilding on changes.
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("[build-server] watching for changes…");
} else {
  await esbuild.build(buildOptions);
}
