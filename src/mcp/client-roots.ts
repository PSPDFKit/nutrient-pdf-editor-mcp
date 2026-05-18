/**
 * Per-process MCP client-roots registry.
 *
 * Each MCP server process maintains its own in-memory list of roots advertised
 * by the client via `roots/list`. This module is intentionally NOT shared across
 * processes — in the multi-process Cowork workaround (NUTRIENT_SHARED_STATE=1),
 * each process receives its own `roots/list` notification at `initialize` time
 * and calls `setClientRoots` independently. There is no file-backed or
 * cross-IPC synchronisation here.
 *
 * The path guard (`validatePathInAllowedRootsAtOpenTime`) is an open-time-only
 * check by design — see the comment header on that function in `path-guard.ts`.
 * Do not attempt to share this module's state via the file backend; that would
 * introduce TOCTOU exposure across processes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ClientFileRoot {
  uri: string;
  path: string;
  kind: "file";
}
interface ClientDirRoot {
  uri: string;
  path: string;
  // realpath cached at setClientRoots time so path-guard's
  // isUnderAnyDirRoot does not call realpathSync on every tool invocation.
  // Recomputed on every setClientRoots call; may be undefined if the root
  // path has a broken symlink at registration time (rare — we silently omit
  // the cache entry rather than failing the entire registration).
  realpath: string | undefined;
  kind: "directory";
}
type ClientRoot = ClientFileRoot | ClientDirRoot;

let clientRoots: ClientRoot[] = [];

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    // Malformed file:// URI — fall back to manual decode for permissive
    // behavior (matches the previous implementation).
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  }
}

function tryRealpathSync(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

// Ingest roots advertised by the MCP client via `roots/list`. Each root URI
// must be a file:// URL per the spec; we statSync to classify file vs.
// directory and silently drop any that don't exist on disk. Mirrors the
// `refreshRoots` behavior in @modelcontextprotocol/ext-apps/examples/pdf-server.
// realpathSync of each directory root is computed once here and cached
// so path-guard can skip the repeated realpathSync on every tool call.
export function setClientRoots(roots: Array<{ uri: string; name?: string }>): void {
  const next: ClientRoot[] = [];
  for (const r of roots) {
    const p = fileUriToPath(r.uri);
    if (p === null) continue;
    const resolved = path.resolve(p);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isFile()) {
        next.push({ uri: r.uri, path: resolved, kind: "file" });
      } else if (stat.isDirectory()) {
        next.push({
          uri: r.uri,
          path: resolved,
          realpath: tryRealpathSync(resolved),
          kind: "directory"
        });
      }
    } catch {
      // Non-existent root → skip.
    }
  }
  clientRoots = next;
}

export function getClientFileRoots(): string[] {
  return clientRoots.filter((r) => r.kind === "file").map((r) => r.path);
}

export function getClientDirRoots(): string[] {
  return clientRoots.filter((r) => r.kind === "directory").map((r) => r.path);
}

// Pre-resolved realpath for each directory root; undefined when realpath
// was unavailable at registration time. Consumed by path-guard's
// isUnderAnyDirRoot so it can skip realpathSync on the directory side.
export function getClientDirRootsResolved(): Array<{ path: string; realpath: string | undefined }> {
  return (clientRoots.filter((r) => r.kind === "directory") as ClientDirRoot[]).map((r) => ({
    path: r.path,
    realpath: r.realpath
  }));
}

// Flat list (file + dir) — used for diagnostic messages and VM-path rewriting.
export function getClientRootPaths(): string[] {
  return clientRoots.map((r) => r.path);
}

export function clearClientRoots(): void {
  clientRoots = [];
}
