#!/usr/bin/env node
/**
 * Pre-build guard: verify that `VITE_NUTRIENT_LICENSE_KEY` is configured
 * deliberately before producing a `.mcpb`. A build with the var unset
 * silently ships a trial-mode viewer that watermarks every page, which
 * is almost never what the builder intended.
 *
 * Outcomes:
 *   - unset                              → fail (config drift)
 *   - matches the .env.example placeholder → fail (template not edited)
 *   - empty string                        → loud TRIAL banner, allow
 *   - real value                          → silent pass
 *
 * The empty-string case is the explicit opt-out: the builder edited
 * `.env` to `VITE_NUTRIENT_LICENSE_KEY=`, which differs from the
 * `<YOUR_LICENSE_KEY_HERE>` placeholder in `.env.example`, so it can
 * only be reached on purpose.
 *
 * The script never prints the resolved license value — only the
 * classification — to keep secrets out of CI logs.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "vite";
import { rootDir } from "./lib.mjs";

export const VAR_NAME = "VITE_NUTRIENT_LICENSE_KEY";

export function readPlaceholder(envExamplePath) {
  if (!fs.existsSync(envExamplePath)) return null;
  const content = fs.readFileSync(envExamplePath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== VAR_NAME) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

export function classify(actual, placeholder) {
  if (actual === undefined) return { kind: "unset" };
  if (placeholder !== null && placeholder !== "" && actual === placeholder) {
    return { kind: "placeholder", placeholder };
  }
  if (actual === "") return { kind: "empty" };
  return { kind: "real" };
}

function printTrialBanner(warn) {
  const line = "━".repeat(64);
  warn("");
  warn(`⚠️  ${line}`);
  warn(`⚠️  TRIAL MODE BUILD — ${VAR_NAME} is empty by request.`);
  warn("⚠️");
  warn("⚠️  The viewer in this .mcpb will run in trial mode and");
  warn("⚠️  display the Nutrient watermark on every page.");
  warn("⚠️  Do NOT distribute this artefact to end users.");
  warn(`⚠️  ${line}`);
  warn("");
}

export function reportAndExit(
  result,
  {
    exit = process.exit,
    log = console.log,
    warn = console.warn,
    error = console.error
  } = {}
) {
  switch (result.kind) {
    case "unset":
      error(`✗ ${VAR_NAME} is not set.`);
      error(`  Either set a real license key in .env (copy .env.example),`);
      error(`  or set it to an empty string (\`${VAR_NAME}=\`) to`);
      error(`  deliberately build a trial-mode artefact.`);
      return exit(1);
    case "placeholder":
      error(`✗ ${VAR_NAME} still matches the .env.example placeholder.`);
      error(`  Looks like .env was copied from .env.example without editing.`);
      error(`  Set a real license key, or set it to an empty string`);
      error(`  (\`${VAR_NAME}=\`) to opt into a trial-mode build.`);
      return exit(1);
    case "empty":
      printTrialBanner(warn);
      return exit(0);
    case "real":
      log(`✓ ${VAR_NAME} is set (production build).`);
      return exit(0);
    default:
      error(`✗ Unknown classification: ${JSON.stringify(result)}`);
      return exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv("production", rootDir, "VITE_");
  const placeholder = readPlaceholder(path.join(rootDir, ".env.example"));
  const result = classify(env[VAR_NAME], placeholder);
  reportAndExit(result);
}
