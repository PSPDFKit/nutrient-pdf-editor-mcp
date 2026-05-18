#!/usr/bin/env node
/**
 * Verify that every tool name in allToolsRegistry (src/mcp/server.ts)
 * has a corresponding server.tool() registration, and vice versa.
 *
 * The custom tools/list filter in tool-registry.ts iterates allToolsRegistry
 * to serve tool definitions. If a tool is registered via server.tool() but
 * NOT added to allToolsRegistry (or vice-versa), the model sees an
 * inconsistent tool surface. This script surfaces that drift at build time.
 *
 * Strategy: static parsing of src/mcp/server.ts — no runtime execution required.
 * Exit 0 on alignment, 1 on drift.
 */

import fs from "node:fs";
import path from "node:path";
import { rootDir } from "./lib.mjs";

const serverTsPath = path.join(rootDir, "src", "mcp", "server.ts");

if (!fs.existsSync(serverTsPath)) {
  console.error(`✗ verify-registry-sync: ${serverTsPath} not found`);
  process.exit(1);
}

const src = fs.readFileSync(serverTsPath, "utf8");

// Extract all allToolsRegistry.set("toolName", ...) entries
const registrySetPattern = /allToolsRegistry\.set\(\s*["']([^"']+)["']/g;
const registryNames = new Set();
let m;
while ((m = registrySetPattern.exec(src)) !== null) {
  registryNames.add(m[1]);
}

// Extract all server.tool("toolName", ...) registrations
// This covers both direct calls and calls via registerXxx helpers.
// We parse the tool name from direct server.tool("name", ...) calls only —
// tools registered via helpers (registerOpenDocument, etc.) register their
// own name internally, so we rely on allToolsRegistry as the authoritative list.
// What we CAN verify: every key in allToolsRegistry has exactly one server.tool() call
// for that name in the whole src/ tree.
const srcDir = path.join(rootDir, "src");

function findTsFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      files.push(...findTsFiles(path.join(dir, e.name)));
    } else if (e.name.endsWith(".ts")) {
      files.push(path.join(dir, e.name));
    }
  }
  return files;
}

const allSrcTs = findTsFiles(srcDir);
const sdkRegisteredNames = new Set();
const serverToolPattern = /server\.tool\(\s*["']([^"']+)["']/g;

// Patterns that register a tool with the SDK:
//   server.tool("name", ...)          — standard tool registration
//   server.registerTool("name", ...)  — registerTool variant (used by close_document)
//   registerAppTool(server, "name",…) — MCP Apps variant (used by open-document)
const TOOL_REGISTRATION_PATTERNS = [
  /server\.tool\(\s*["']([^"']+)["']/g,
  /server\.registerTool\(\s*["']([^"']+)["']/g,
  /registerAppTool\(\s*\w+\s*,\s*["']([^"']+)["']/g,
];

for (const file of allSrcTs) {
  const content = fs.readFileSync(file, "utf8");
  for (const pattern of TOOL_REGISTRATION_PATTERNS) {
    // Reset lastIndex since patterns are reused across files
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      sdkRegisteredNames.add(match[1]);
    }
  }
}

// One-directional check: every name in allToolsRegistry must have a
// corresponding SDK registration somewhere in src/. The reverse is NOT
// required — internal tools (poll_commands, submit_response,
// write_document_bytes) are intentionally registered via server.tool() but
// excluded from allToolsRegistry.
const inRegistryButNotSdk = [...registryNames].filter((n) => !sdkRegisteredNames.has(n));

if (inRegistryButNotSdk.length > 0) {
  console.error("✗ verify-registry-sync: allToolsRegistry / server.tool() drift detected");
  console.error("\n  In allToolsRegistry but no matching SDK registration found:");
  for (const name of inRegistryButNotSdk) {
    console.error(`    - ${name}`);
  }
  console.error(
    "\nFix: ensure every allToolsRegistry.set() entry has a matching server.tool() / " +
    "registerAppTool() / server.registerTool() call in src/mcp/**/*.ts."
  );
  process.exit(1);
}

console.log("✓ verify-registry-sync: all allToolsRegistry entries have matching SDK registrations");
console.log(`  ${registryNames.size} registry entry/entries verified`);
