#!/usr/bin/env node
/**
 * Verify version consistency across distribution manifests.
 *
 * Source of truth: package.json#version.
 * Must match: manifest.json#version (.mcpb bundle for Claude Desktop / Code).
 */

import { readJson } from "./lib.mjs";

const pkg = readJson("package.json");
const manifest = readJson("manifest.json");

const expected = pkg.version;
const drift = [];
if (manifest.version !== expected) {
  drift.push(`manifest.json has "${manifest.version}"`);
}

if (drift.length > 0) {
  console.error(`❌ Version drift from package.json ("${expected}"):`);
  for (const message of drift) {
    console.error(`   - ${message}`);
  }
  console.error(`\nUpdate each file's "version" to "${expected}".`);
  process.exit(1);
}

console.log("✓ Version consistency check passed");
console.log(`  version: ${expected} (package.json, manifest.json)`);
