import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  getClientFileRoots,
  getClientDirRoots,
  getClientDirRootsResolved,
  getClientRootPaths
} from "./client-roots.js";

// Cowork mounts the user's host workspace into the VM at a handful of well-known
// prefixes. When a host-installed MCP server receives one of these paths from
// Claude-in-Cowork, we strip the VM prefix and resolve the remainder against an
// MCP client-advertised root. Tracking issue:
// https://github.com/anthropics/claude-code/issues/27758
const VM_MOUNT_PREFIXES: RegExp[] = [
  /^\/mnt\/\.virtiofs-root\/shared\//,
  /^\/mnt\/virtiofs\//,
  /^\/sessions\/[^/]+\/mnt\/(?:Work|uploads|Downloads)\//
];

function stripVmPrefix(input: string): string | null {
  for (const re of VM_MOUNT_PREFIXES) {
    if (re.test(input)) return input.replace(re, "");
  }
  return null;
}

function isFileUrl(s: string): boolean {
  return s.startsWith("file://");
}

function decodeFileUrlOrPath(input: string): string {
  if (isFileUrl(input)) return fileURLToPath(input);
  // Bare path — decode percent-escapes (e.g. spaces sent as %20).
  return decodeURIComponent(input);
}

// Robust ancestor check using path.relative. A path is "under" `dir` iff
// the relative path is non-empty (excludes the dir itself), doesn't escape
// upward (..), and isn't on a different drive (absolute on Windows).
// Mirrors `isAncestorDir` in @modelcontextprotocol/ext-apps/examples/pdf-server.
function isAncestorDir(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function tryRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

// A dir root entry is either a plain string (realpath resolved on-demand) or a
// pre-resolved object (realpath cached at registration time by client-roots.ts).
type DirRoot = string | { path: string; realpath: string | undefined };

// Walk every advertised dir root and check the candidate against both the
// raw path and its realpath, on both sides. Catches symlinks pointing
// in/out of mounted directories — same shape as pdf-server.
//
// Accepts plain strings (VM-prefix branch, single-element array built from a
// root) or pre-resolved objects from getClientDirRootsResolved() (main path,
// avoids repeated realpathSync per tool invocation). When given a plain string,
// realDir is resolved lazily via tryRealpath; when given an object, the cached
// realpath is used as-is — preserving the TOCTOU semantics of the cached variant.
function isUnderAnyDirRoot(absolute: string, dirs: DirRoot[]): boolean {
  const realAbsolute = tryRealpath(absolute);
  return dirs.some((entry) => {
    const dir = typeof entry === "string" ? entry : entry.path;
    const realDir = typeof entry === "string" ? tryRealpath(entry) : entry.realpath;
    return (
      isAncestorDir(dir, absolute) ||
      (realAbsolute !== undefined && isAncestorDir(dir, realAbsolute)) ||
      (realDir !== undefined && isAncestorDir(realDir, absolute)) ||
      (realDir !== undefined && realAbsolute !== undefined && isAncestorDir(realDir, realAbsolute))
    );
  });
}

// Validate a path against the MCP client-advertised roots (per the spec's
// `roots/list` mechanism — see https://modelcontextprotocol.io/specification/2025-06-18/client/roots).
// Mirrors the validation surface from @modelcontextprotocol/ext-apps's
// pdf-server (`validateUrl`): file:// URLs and bare paths both accepted,
// dir roots checked with realpath/symlink fallback, file roots checked by
// exact match, percent-encoded inputs decoded.
//
// This is an OPEN-TIME-ONLY check — it runs once when open_document is called
// and resolves the canonical absolute path. It is NOT called on every subsequent
// operating-tool invocation. This matches the per-process design in client-roots.ts:
// each process receives `roots/list` once at `initialize` time; path validation
// is meaningful only at open time when the path is provided by the caller.
//
// The symbol name encodes this contract: callers outside of open-document.ts
// should not import this function. See the unit test in tests/mcp/path-guard.test.ts
// that asserts only open-document.ts imports this symbol.
//
// Fails fast: there is no env-var fallback. If the client hasn't declared
// the `roots` capability and exposed at least one root, every document tool
// call rejects with a clear error.
export function validatePathInAllowedRootsAtOpenTime(input: string): string {
  const fileRoots = getClientFileRoots();
  const dirRoots = getClientDirRoots();
  const dirRootsResolved = getClientDirRootsResolved();
  if (fileRoots.length === 0 && dirRoots.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "MCP client has not advertised any filesystem roots. The client must declare the `roots` capability and expose at least one root via `roots/list` before document tools can be used."
    );
  }

  // VM paths from Claude-in-Cowork need to be rewritten onto a real host
  // root (the host-installed server can't read /mnt/virtiofs/ directly).
  // Try every advertised root — files OR dirs — to find one that contains
  // the rewritten path.
  const vmRelative = stripVmPrefix(input);
  if (vmRelative !== null) {
    const allRoots = [...fileRoots, ...dirRoots];
    for (const root of allRoots) {
      const candidate = path.resolve(root, vmRelative);
      // Apply the same isUnderAnyDirRoot realpath check that the
      // non-VM path uses, so a symlink inside the root that resolves to a
      // location OUTSIDE every allowed root is correctly rejected even on the
      // VM-prefix branch. The prior isAncestorDir-only check would accept a
      // candidate that passes the text-path test but is a symlink escaping
      // the root boundary.
      if (isUnderAnyDirRoot(candidate, [root]) && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      `VM path ${input} not found under any MCP-advertised root: ${allRoots.join(", ")}`
    );
  }

  // Decode file:// URL or percent-escaped bare path, then resolve to absolute.
  const decoded = decodeFileUrlOrPath(input);
  const abs = path.resolve(decoded);

  // Exact match against file roots (single-file roots advertised by client).
  if (fileRoots.includes(abs)) {
    if (!fs.existsSync(abs)) {
      throw new McpError(ErrorCode.InvalidParams, `File not found: ${abs}`);
    }
    return abs;
  }

  // Ancestor match against dir roots, with realpath/symlink fallback.
  // Use cached realpaths from setClientRoots to avoid repeated realpathSync.
  if (isUnderAnyDirRoot(abs, dirRootsResolved)) {
    if (!fs.existsSync(abs)) {
      throw new McpError(ErrorCode.InvalidParams, `File not found: ${abs}`);
    }
    return abs;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Path outside MCP-advertised roots: ${abs}. Advertised roots: ${getClientRootPaths().join(", ")}`
  );
}
