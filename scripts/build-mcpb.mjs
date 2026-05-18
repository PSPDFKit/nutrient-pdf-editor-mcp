#!/usr/bin/env node
/**
 * Build the .mcpb distribution bundle for direct install in Claude Desktop / Code.
 *
 * Assumes `dist/` is populated (run the earlier `build:viewer` / `build:server`
 * steps first). Stages `index.js` + `mcp-app.html` (the CDN-loading viewer
 * variant) under `server/` so the manifest's `${__dirname}/server/index.js`
 * entry can locate `mcp-app.html` via `import.meta.dirname`. The SDK UMD
 * script bundle, worker, and wasm assets are all fetched at runtime from the
 * public Nutrient CDN — see src/mcp/app-resource.ts. The MCPB therefore
 * requires network access on first launch.
 *
 * Output: build/<package-name>-<VERSION>.mcpb (derived from package.json#name)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readJson, rootDir } from "./lib.mjs";

const distDir = path.join(rootDir, "dist");
const manifestPath = path.join(rootDir, "manifest.json");
const iconPath = path.join(rootDir, "icon.png");
const screenshotsDir = path.join(rootDir, "assets", "screenshots");
const buildDir = path.join(rootDir, "build");
const stagingDir = path.join(buildDir, "mcpb-staging");
const serverStagingDir = path.join(stagingDir, "server");

const pkg = readJson("package.json");
const pkgBaseName = pkg.name.split("/").pop();
const outputPath = path.join(buildDir, `${pkgBaseName}-${pkg.version}.mcpb`);

if (!fs.existsSync(distDir)) {
  console.error("[build-mcpb] dist/ not found — run `npm run build` first.");
  process.exit(1);
}
for (const required of ["index.js", "mcp-app.html"]) {
  if (!fs.existsSync(path.join(distDir, required))) {
    console.error(`[build-mcpb] dist/${required} missing — incomplete build.`);
    process.exit(1);
  }
}
if (!fs.existsSync(manifestPath)) {
  console.error("[build-mcpb] manifest.json not found at repo root.");
  process.exit(1);
}
if (!fs.existsSync(iconPath)) {
  console.error("[build-mcpb] icon.png not found at repo root.");
  process.exit(1);
}
if (!fs.existsSync(screenshotsDir)) {
  console.error("[build-mcpb] assets/screenshots/ not found.");
  process.exit(1);
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(serverStagingDir, { recursive: true });

for (const entry of ["index.js", "mcp-app.html"]) {
  fs.cpSync(path.join(distDir, entry), path.join(serverStagingDir, entry), { recursive: true });
}
fs.cpSync(manifestPath, path.join(stagingDir, "manifest.json"));
fs.cpSync(iconPath, path.join(stagingDir, "icon.png"));
fs.cpSync(screenshotsDir, path.join(stagingDir, "assets", "screenshots"), { recursive: true });

fs.rmSync(outputPath, { force: true });
execFileSync(
  "npx",
  ["--yes", "@anthropic-ai/mcpb", "pack", stagingDir, outputPath],
  { stdio: "inherit", cwd: rootDir },
);

const { size } = fs.statSync(outputPath);
const mb = (size / 1024 / 1024).toFixed(1);
console.error(`[build-mcpb] ${outputPath} (${mb} MB)`);
