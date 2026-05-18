#!/usr/bin/env node
/**
 * Verify that the MCP server's `serverInfo.name` matches the manifest display
 * name that the host uses to key the .mcpb connection.
 *
 * Why this exists: the host (Claude Desktop installs the .mcpb; Cowork is
 * what actually renders the iframe at runtime) looks up MCP-App resources by
 * the host-side display name (`manifest.json#display_name`). If the value
 * passed to `new McpServer({ name: ... })` drifts from that, the host
 * silently skips `resources/read` and the iframe never renders. See debug
 * session 2026-04-28-diagnose-cowork-iframe-not-rendering for the original
 * repro.
 *
 * Source of truth: manifest.json#display_name.
 * Must match: src/mcp/server.ts → `new McpServer({ name: "..." }, ...)`
 * first arg.
 */

import fs from "node:fs";
import path from "node:path";
import { readJson, rootDir } from "./lib.mjs";

function readText(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), "utf8");
}

const manifest = readJson("manifest.json");
const expected = manifest.display_name;
if (typeof expected !== "string" || expected.length === 0) {
  console.error('❌ manifest.json#display_name is missing or empty');
  process.exit(1);
}

// Extract the first arg of `new McpServer({ name: "..." }, ...)` from server.ts.
const serverSrc = readText("src/mcp/server.ts");
const match = serverSrc.match(/new\s+McpServer\s*\(\s*\{\s*name:\s*"([^"]+)"/);
if (!match) {
  console.error(
    '❌ Could not find `new McpServer({ name: "..." })` in src/mcp/server.ts'
  );
  process.exit(1);
}
const serverInfoName = match[1];

const drift = [];
if (serverInfoName !== expected) {
  drift.push(
    `src/mcp/server.ts → new McpServer({ name: "${serverInfoName}" }) does not match manifest.json#display_name "${expected}"`
  );
}

if (drift.length > 0) {
  console.error(
    `❌ Server name drift from manifest.json#display_name ("${expected}"):`
  );
  for (const message of drift) {
    console.error(`   - ${message}`);
  }
  console.error(
    `\nBoth must equal "${expected}" so the host's resource lookup succeeds.`
  );
  process.exit(1);
}

console.log("✓ Server name consistency check passed");
console.log(
  `  display name: "${expected}" (manifest.json, src/mcp/server.ts)`
);
