// Shared helpers for scripts/verify-*.mjs and scripts/build-*.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.join(__dirname, "..");

export function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relPath), "utf8"));
}
