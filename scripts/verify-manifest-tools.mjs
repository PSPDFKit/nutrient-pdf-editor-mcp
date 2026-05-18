#!/usr/bin/env node
/**
 * Verify two things at build time:
 *
 *   1. manifest.json#tools[] matches the live tools/list served by the
 *      MCP server (i.e., the public tool surface exposed to the model).
 *      Drift between the manifest and the registered tools fails the
 *      build.
 *
 *   2. Every public tool registration carries the marketplace-required
 *      annotations: a non-empty `title` string, plus the
 *      `readOnlyHint` / `destructiveHint` boolean(s) where applicable
 *      (per Anthropic's submission criteria —
 *      https://claude.com/docs/connectors/building/submission). A
 *      missing or wrong annotation fails the build.
 *
 * Strategy: static parse of `src/mcp/server.ts` (for the registry
 * `.set()` calls) and `src/mcp/tools/*.ts` (for the registration
 * configs). No runtime execution required — keeping the verifier
 * dependency-free means it runs early in the build pipeline, before
 * mcpb packaging.
 *
 * The core logic is exported as `runVerifier({ rootDir })` so tests
 * can drive it against synthetic fixtures without spawning a node
 * subprocess. The CLI wrapper at the bottom invokes the same function
 * against the project root.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- Source-of-truth annotation contract ----------

/**
 * Tools that MUST declare `readOnlyHint: true`. Source: task-077 brief
 * + docs/tool-surface.md (the read-only tools that don't mutate
 * document state).
 */
export const READ_ONLY_TOOLS = new Set([
  "get_view_state",
  "search_exact_text",
  "read_document_information",
  "read_page_info",
  "get_page_image",
  "read_text",
  "read_annotations",
  "read_form_fields"
]);

/**
 * Tools that MUST declare `destructiveHint: true`. Source: task-077
 * brief — `apply_annotations` burns redactions permanently to disk.
 */
export const DESTRUCTIVE_TOOLS = new Set(["apply_annotations"]);

/**
 * Internal viewer-only tools: hidden from `tools/list` by
 * `installInternalToolsFilter`. They aren't part of the public manifest
 * surface so they're skipped by every check below.
 */
export const INTERNAL_TOOL_NAMES = new Set([
  "poll_commands",
  "submit_response",
  "write_document_bytes",
  "viewer_event"
]);

// ---------- Static-parse helpers ----------

/**
 * Find the `{ ... }` config object that immediately follows a
 * registration callsite at `startIndex`. Returns the substring inside
 * the matched braces (excluding the braces themselves), or `null` if
 * no balanced object was found within `maxLen` characters of the start.
 *
 * Skips quoted string contents (single, double, and template-literal
 * backticks) and `//`-style line comments so braces inside those don't
 * throw off the depth counter. Multi-line `/* * /` comments are not
 * stripped — none of the tool registrations use them inside the config
 * object today, and adding the parse adds risk for no benefit. If a
 * tool ever does use them inside the config, the regex-based
 * fallback assertions below will surface the missing field.
 */
function extractConfigObject(src, startIndex, maxLen = 20000) {
  // Find the first `{` at or after startIndex (skipping intervening
  // whitespace, the `(`, and the tool-name string literal).
  let i = startIndex;
  let braceStart = -1;
  while (i < src.length && i < startIndex + maxLen) {
    const ch = src[i];
    if (ch === "{") {
      braceStart = i;
      break;
    }
    i++;
  }
  if (braceStart < 0) return null;

  let depth = 0;
  let inString = null; // "'" | '"' | '`' | null
  let inLineComment = false;
  let i2 = braceStart;
  const end = Math.min(src.length, braceStart + maxLen);
  while (i2 < end) {
    const ch = src[i2];
    const next = src[i2 + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i2++;
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i2 += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i2++;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i2 += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i2++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(braceStart + 1, i2);
      }
    }
    i2++;
  }
  return null;
}

/**
 * For a `defineOperatingTool` callsite that starts at `tokenEndIndex`
 * (i.e. just after the matched `defineOperatingTool` token), advance
 * past the optional generic parameter list `<...>` and the leading
 * positional arguments (`server, registry,`) until the cursor sits
 * just before the config-object literal. Returns the new cursor index,
 * or -1 if the callsite shape is unrecognised.
 *
 * Walks balanced `<>` for generics (so nested generics like
 * `Record<string, never>` don't bail out early) and balanced `()` for
 * the call's arg list, both with string-aware skipping so quoted `,`
 * and `<` don't throw off the depth counter.
 */
function seekDefineOperatingToolConfig(src, tokenEndIndex) {
  let i = tokenEndIndex;
  // 1. Skip whitespace.
  while (i < src.length && /\s/.test(src[i])) i++;

  // 2. Optional `<...>` generic parameter list — balance angle
  // brackets, with awareness of strings.
  if (src[i] === "<") {
    let depth = 0;
    let inString = null;
    while (i < src.length) {
      const ch = src[i];
      if (inString) {
        if (ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === inString) inString = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        i++;
        continue;
      }
      if (ch === "<") depth++;
      else if (ch === ">") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    if (depth !== 0) return -1;
    while (i < src.length && /\s/.test(src[i])) i++;
  }

  // 3. Required `(` to start the call.
  if (src[i] !== "(") return -1;
  i++;

  // 4. Skip the first two arguments (server, registry). Track depth on
  // `()`, `[]`, `{}` and string state; advance past two top-level commas.
  let parenDepth = 1;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = null;
  let commasSeen = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      i++;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")") {
      parenDepth--;
      if (parenDepth === 0) return -1; // ran past the call
    } else if (ch === "[") bracketDepth++;
    else if (ch === "]") bracketDepth--;
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    else if (
      ch === "," &&
      parenDepth === 1 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      commasSeen++;
      if (commasSeen === 2) {
        // Cursor sits on the comma between arg 2 and arg 3 (the config
        // object). `extractConfigObject` advances to the next `{`.
        return i + 1;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Collects all public-tool registrations from the project tree.
 *
 * For each `.ts` file under `src/mcp/tools/`, finds every callsite of
 * one of the four registration shapes (`server.tool`,
 * `server.registerTool`, `registerAppTool`, `defineOperatingTool`) and
 * extracts:
 *   - the tool name (first `"..."` literal after the callsite)
 *   - the registration config object body (between the matched braces)
 *
 * Returns an array of `{ name, file, configBody }`. Internal tools are
 * filtered out. Each file may contribute more than one tool (e.g.
 * `view-state.ts` registers both `get_view_state` and `set_view_state`).
 */
export function collectToolRegistrations(toolsDir) {
  const out = [];
  if (!fs.existsSync(toolsDir)) return out;

  // Each pattern captures the tool name. The matched callsite is at
  // `match.index + match[0].length` (approximately) — we then look for
  // the next `{` to find the config object. For `defineOperatingTool`
  // the tool name lives inside the config object itself, so we instead
  // open the config first and pull `name:` out of it.
  const REG_PATTERNS = [
    {
      kind: "named-callsite",
      // matches: server.tool("name", ...) / server.registerTool("name", ...)
      regex: /(?:server\.tool|server\.registerTool)\s*\(\s*["']([a-z][a-z0-9_]*)["']\s*,/g
    },
    {
      kind: "named-callsite",
      // matches: registerAppTool(server, "name", ...)
      regex: /registerAppTool\s*\(\s*\w+\s*,\s*["']([a-z][a-z0-9_]*)["']\s*,/g
    },
    {
      kind: "define-operating-tool",
      // Locates the bare callsite token. The handler below then walks
      // past optional generic parameters (which can themselves be
      // nested, e.g. `Record<string, never>`) and the first two
      // positional arguments (`server, <registry>,`) before handing the
      // cursor to `extractConfigObject`. A regex can't do balanced
      // bracket scans, so the post-match walk is custom logic — see
      // `seekToConfigObject` below.
      regex: /\bdefineOperatingTool\b/g,
      seek: seekDefineOperatingToolConfig
    }
  ];

  for (const file of fs.readdirSync(toolsDir).sort()) {
    if (!file.endsWith(".ts")) continue;
    const fullPath = path.join(toolsDir, file);
    const src = fs.readFileSync(fullPath, "utf8");

    for (const pattern of REG_PATTERNS) {
      const { kind, regex, seek } = pattern;
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(src)) !== null) {
        const tokenEnd = match.index + match[0].length;
        const callsiteEnd = seek ? seek(src, tokenEnd) : tokenEnd;
        if (callsiteEnd < 0) continue;
        const configBody = extractConfigObject(src, callsiteEnd);
        if (!configBody) continue;

        let name;
        if (kind === "named-callsite") {
          name = match[1];
        } else {
          // defineOperatingTool: pull the `name:` field out of the body.
          const nameInBody = /\bname:\s*["']([a-z][a-z0-9_]*)["']/.exec(configBody);
          if (!nameInBody) continue;
          name = nameInBody[1];
        }

        if (INTERNAL_TOOL_NAMES.has(name)) continue;
        out.push({ name, file, configBody });
      }
    }
  }
  return out;
}

/**
 * Assert annotation invariants on the collected registrations. Returns
 * `{ ok, errors, count }` so the caller can surface every problem in a
 * single build run rather than fail-fast on the first one.
 */
export function checkAnnotations(registrations) {
  const errors = [];
  const seen = new Set();

  for (const { name, file, configBody } of registrations) {
    seen.add(name);

    // 1. `title:` must be a non-empty string literal.
    const titleMatch = /\btitle:\s*["']([^"']*)["']/.exec(configBody);
    if (!titleMatch) {
      errors.push(`${name} (${file}): missing \`title\` field on registration`);
    } else if (titleMatch[1].trim() === "") {
      errors.push(`${name} (${file}): \`title\` is empty`);
    }

    // 2. `annotations:` object must be present (even if empty).
    const hasAnnotations = /\bannotations:\s*\{/.test(configBody);
    if (!hasAnnotations) {
      errors.push(
        `${name} (${file}): missing \`annotations\` object — declare \`annotations: {}\` for tools with no hints`
      );
    }

    // 3. Read-only tools must declare `readOnlyHint: true`.
    if (READ_ONLY_TOOLS.has(name)) {
      if (!/\breadOnlyHint:\s*true\b/.test(configBody)) {
        errors.push(
          `${name} (${file}): expected \`readOnlyHint: true\` in \`annotations\` (read-only tool)`
        );
      }
    }

    // 4. Destructive tools must declare `destructiveHint: true`.
    if (DESTRUCTIVE_TOOLS.has(name)) {
      if (!/\bdestructiveHint:\s*true\b/.test(configBody)) {
        errors.push(
          `${name} (${file}): expected \`destructiveHint: true\` in \`annotations\` (destructive tool)`
        );
      }
    }

    // 5. A read-only or destructive tool must NOT carry the wrong hint.
    if (READ_ONLY_TOOLS.has(name) && /\bdestructiveHint:\s*true\b/.test(configBody)) {
      errors.push(
        `${name} (${file}): read-only tool unexpectedly declares \`destructiveHint: true\``
      );
    }
    if (DESTRUCTIVE_TOOLS.has(name) && /\breadOnlyHint:\s*true\b/.test(configBody)) {
      errors.push(
        `${name} (${file}): destructive tool unexpectedly declares \`readOnlyHint: true\``
      );
    }
  }

  // 6. Every member of READ_ONLY_TOOLS / DESTRUCTIVE_TOOLS must be
  // covered by some registration. Catches the "tool was deleted but the
  // contract entry was forgotten" case.
  for (const required of READ_ONLY_TOOLS) {
    if (!seen.has(required)) {
      errors.push(
        `${required}: declared as a read-only public tool but no registration found in src/mcp/tools/`
      );
    }
  }
  for (const required of DESTRUCTIVE_TOOLS) {
    if (!seen.has(required)) {
      errors.push(
        `${required}: declared as a destructive public tool but no registration found in src/mcp/tools/`
      );
    }
  }

  return { ok: errors.length === 0, errors, count: registrations.length };
}

// ---------- Manifest-vs-registry drift check ----------

/**
 * Returns the public tool name set declared in `src/mcp/server.ts`
 * (allToolsRegistry.set("name", …)) plus any `defineOperatingTool`
 * names from `src/mcp/tools/`. Mirrors the original verifier's logic so
 * this script's manifest-comparison behaviour is unchanged.
 */
export function collectPublicToolNames(rootDir) {
  const serverTsPath = path.join(rootDir, "src", "mcp", "server.ts");
  if (!fs.existsSync(serverTsPath)) {
    throw new Error(`${serverTsPath} not found`);
  }
  const serverSrc = fs.readFileSync(serverTsPath, "utf8");

  const registrySetPattern = /allToolsRegistry\.set\(\s*["']([^"']+)["']/g;
  const registryNames = new Set();
  let m;
  while ((m = registrySetPattern.exec(serverSrc)) !== null) {
    registryNames.add(m[1]);
  }

  const toolsDir = path.join(rootDir, "src", "mcp", "tools");
  if (fs.existsSync(toolsDir)) {
    const namePattern = /\bname:\s*["']([a-z][a-z0-9_]*)["']/;
    for (const file of fs.readdirSync(toolsDir)) {
      if (!file.endsWith(".ts")) continue;
      const src = fs.readFileSync(path.join(toolsDir, file), "utf8");
      const factoryStart = src.indexOf("defineOperatingTool");
      if (factoryStart < 0) continue;
      const match = namePattern.exec(src.slice(factoryStart));
      if (match) registryNames.add(match[1]);
    }
  }

  return new Set([...registryNames].filter((name) => !INTERNAL_TOOL_NAMES.has(name)));
}

/**
 * Run all verifier checks against `rootDir`. Returns an `errors[]`
 * array; an empty array means success. Designed for both CLI invocation
 * and test fixtures — never calls `process.exit` itself.
 */
export function runVerifier(rootDir) {
  const errors = [];

  // ---------- Load manifest.json ----------
  const manifestPath = path.join(rootDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return { errors: [`${manifestPath} not found`], publicToolCount: 0 };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifestToolNames = new Set((manifest.tools ?? []).map((t) => t.name));

  // ---------- Manifest vs. registry ----------
  let publicToolNames;
  try {
    publicToolNames = collectPublicToolNames(rootDir);
  } catch (err) {
    return { errors: [err.message], publicToolCount: 0 };
  }
  const inManifestButNotRegistry = [...manifestToolNames].filter((n) => !publicToolNames.has(n));
  const inRegistryButNotManifest = [...publicToolNames].filter((n) => !manifestToolNames.has(n));

  if (inManifestButNotRegistry.length > 0) {
    errors.push("manifest.json / server tools drift: in manifest but not registered");
    for (const name of inManifestButNotRegistry) errors.push(`  - ${name}`);
  }
  if (inRegistryButNotManifest.length > 0) {
    errors.push("manifest.json / server tools drift: registered but missing from manifest");
    for (const name of inRegistryButNotManifest) errors.push(`  - ${name}`);
  }

  // ---------- Annotation invariants ----------
  const toolsDir = path.join(rootDir, "src", "mcp", "tools");
  const registrations = collectToolRegistrations(toolsDir);
  const { errors: annotationErrors } = checkAnnotations(registrations);
  errors.push(...annotationErrors);

  return { errors, publicToolCount: publicToolNames.size };
}

// ---------- CLI ----------

// Detect direct CLI invocation. import.meta.url === pathToFileURL(argv[1])
// would be the canonical check, but a simpler equality on the resolved
// path is robust enough for npm scripts.
const isCli = (() => {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    return process.argv[1] && path.resolve(process.argv[1]) === thisFile;
  } catch {
    return false;
  }
})();

if (isCli) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.join(__dirname, "..");

  const { errors, publicToolCount } = runVerifier(rootDir);
  if (errors.length > 0) {
    console.error("✗ verify-manifest-tools: drift / missing annotations detected");
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      "\nFix: ensure every public tool registration has a `title`, an `annotations` " +
        "object, the right `readOnlyHint`/`destructiveHint`, and that manifest.json#tools[] " +
        "matches the registered surface."
    );
    process.exit(1);
  }
  console.log("✓ verify-manifest-tools: manifest.json#tools[] + annotations are well-formed");
  console.log(`  ${publicToolCount} public tool(s) verified`);
}
