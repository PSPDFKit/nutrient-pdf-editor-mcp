import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { validatePathInAllowedRootsAtOpenTime } from "../../src/mcp/path-guard.js";
import { setClientRoots, clearClientRoots } from "../../src/mcp/client-roots.js";

describe("validatePathInAllowedRootsAtOpenTime", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-viewer-path-"));
    clearClientRoots();
  });

  afterEach(() => {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    clearClientRoots();
  });

  it("fails fast with a clear message when the client has not advertised any roots", () => {
    expect(() => validatePathInAllowedRootsAtOpenTime("/anywhere")).toThrow(
      /client has not advertised any filesystem roots/i
    );
  });

  it("fails fast on a VM path when no roots are advertised (no env-var fallback)", () => {
    expect(() => validatePathInAllowedRootsAtOpenTime("/mnt/virtiofs/sample.pdf")).toThrow(
      /client has not advertised any filesystem roots/i
    );
  });

  it("accepts a host path under a client-advertised root", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const file = path.join(workspace, "doc.pdf");
    fs.writeFileSync(file, "%PDF");
    expect(validatePathInAllowedRootsAtOpenTime(file)).toBe(file);
  });

  it("rejects a host path outside every advertised root", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    expect(() => validatePathInAllowedRootsAtOpenTime("/etc/passwd")).toThrow(
      /Path outside MCP-advertised roots/
    );
  });

  it("rejects a host path that's under a root but doesn't exist on disk", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const missing = path.join(workspace, "missing.pdf");
    expect(() => validatePathInAllowedRootsAtOpenTime(missing)).toThrow(/File not found/);
  });

  it("rewrites /mnt/virtiofs VM paths onto a client root where the file exists", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const realFile = path.join(workspace, "sample.pdf");
    fs.writeFileSync(realFile, "%PDF");
    expect(validatePathInAllowedRootsAtOpenTime("/mnt/virtiofs/sample.pdf")).toBe(realFile);
  });

  it("rewrites /mnt/.virtiofs-root/shared VM paths onto a client root", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const realFile = path.join(workspace, "nested/a.pdf");
    fs.mkdirSync(path.dirname(realFile), { recursive: true });
    fs.writeFileSync(realFile, "%PDF");
    expect(
      validatePathInAllowedRootsAtOpenTime("/mnt/.virtiofs-root/shared/nested/a.pdf")
    ).toBe(realFile);
  });

  it("rewrites /sessions/<n>/mnt/uploads VM paths onto a client root", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const realFile = path.join(workspace, "cheque.pdf");
    fs.writeFileSync(realFile, "%PDF");
    expect(
      validatePathInAllowedRootsAtOpenTime("/sessions/vigilant-faraday/mnt/uploads/cheque.pdf")
    ).toBe(realFile);
  });

  it("picks the first client root where the rewritten VM path exists", () => {
    const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-viewer-other-"));
    try {
      setClientRoots([
        { uri: pathToFileURL(workspace).href },
        { uri: pathToFileURL(otherWorkspace).href }
      ]);
      const realFile = path.join(otherWorkspace, "only-here.pdf");
      fs.writeFileSync(realFile, "%PDF");
      expect(validatePathInAllowedRootsAtOpenTime("/mnt/virtiofs/only-here.pdf")).toBe(realFile);
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it("rejects a VM path when no advertised root holds the file", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    expect(() => validatePathInAllowedRootsAtOpenTime("/mnt/virtiofs/missing.pdf")).toThrow(
      /VM path .* not found under any MCP-advertised root/
    );
  });

  it("accepts a file:// URL as input and decodes it to a host path", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const file = path.join(workspace, "doc.pdf");
    fs.writeFileSync(file, "%PDF");
    const fileUrl = pathToFileURL(file).href;
    expect(validatePathInAllowedRootsAtOpenTime(fileUrl)).toBe(file);
  });

  it("decodes percent-encoded characters in a bare path (e.g. %20 for space)", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const file = path.join(workspace, "name with space.pdf");
    fs.writeFileSync(file, "%PDF");
    const encoded = path.join(workspace, "name%20with%20space.pdf");
    expect(validatePathInAllowedRootsAtOpenTime(encoded)).toBe(file);
  });

  it("treats a file root as exact-match (cannot be used as a directory)", () => {
    const file = path.join(workspace, "single.pdf");
    fs.writeFileSync(file, "%PDF");
    setClientRoots([{ uri: pathToFileURL(file).href }]);
    expect(validatePathInAllowedRootsAtOpenTime(file)).toBe(file);
    // A different file in the same parent dir is NOT under the file root.
    const sibling = path.join(workspace, "other.pdf");
    fs.writeFileSync(sibling, "%PDF");
    expect(() => validatePathInAllowedRootsAtOpenTime(sibling)).toThrow(
      /Path outside MCP-advertised roots/
    );
  });

  it("accepts a path under a directory root via symlink resolution", () => {
    // Create a symlink OUTSIDE the workspace dir whose target is INSIDE it.
    // Without realpath fallback, the validator would reject the symlink.
    const realFile = path.join(workspace, "real.pdf");
    fs.writeFileSync(realFile, "%PDF");
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-viewer-symlink-"));
    try {
      const linkFile = path.join(linkDir, "link.pdf");
      fs.symlinkSync(realFile, linkFile);
      setClientRoots([{ uri: pathToFileURL(workspace).href }]);
      // Validating the symlink path: realpath(linkFile) → realFile, which
      // is under the workspace dir root. Must succeed.
      expect(validatePathInAllowedRootsAtOpenTime(linkFile)).toBe(linkFile);
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("rejects a path that escapes a dir root via .. (path.relative-based ancestor check)", () => {
    setClientRoots([{ uri: pathToFileURL(workspace).href }]);
    const escape = path.join(workspace, "..", "etc-passwd");
    expect(() => validatePathInAllowedRootsAtOpenTime(escape)).toThrow(
      /Path outside MCP-advertised roots/
    );
  });

  it("skips advertised roots that don't exist on disk at set time", () => {
    const ghost = path.join(os.tmpdir(), "nutrient-viewer-nope-" + Date.now());
    setClientRoots([
      { uri: pathToFileURL(ghost).href },
      { uri: pathToFileURL(workspace).href }
    ]);
    const file = path.join(workspace, "doc.pdf");
    fs.writeFileSync(file, "%PDF");
    // The non-existent root was filtered at set time; the real root accepts the file.
    expect(validatePathInAllowedRootsAtOpenTime(file)).toBe(file);
  });

  // P2-11: VM-prefix branch must apply the same realpath check that the
  // non-VM branch uses for dir-root side (i.e., if the ROOT itself is a
  // symlink). Before P2-11, the VM branch used plain isAncestorDir which only
  // checked text paths; now it uses isUnderAnyDirRoot so the root's realpath
  // is also considered.
  it("accepts a VM path under a root that is itself a symlink (P2-11: realpath check applied)", () => {
    // Create the real directory elsewhere.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrient-viewer-real-"));
    // Create a symlink that points to realDir.
    const symlinkDir = path.join(os.tmpdir(), `nutrient-viewer-symlink-root-${Date.now()}`);
    try {
      fs.symlinkSync(realDir, symlinkDir);

      // Register the SYMLINK as the dir root (not the real dir).
      setClientRoots([{ uri: pathToFileURL(symlinkDir).href }]);

      // Create a file inside the real dir.
      const file = path.join(realDir, "doc.pdf");
      fs.writeFileSync(file, "%PDF");

      // The VM path resolves to symlinkDir/doc.pdf which (via realpath of root)
      // maps to realDir/doc.pdf. With P2-11's realpath check, this is found.
      const result = validatePathInAllowedRootsAtOpenTime("/mnt/virtiofs/doc.pdf");
      expect(result).toBe(path.join(symlinkDir, "doc.pdf"));
    } finally {
      try { fs.rmSync(symlinkDir, { force: true }); } catch { /* best-effort */ }
      fs.rmSync(realDir, { recursive: true, force: true });
    }
  });

  it("ignores NUTRIENT_VIEWER_ALLOWED_ROOTS even if it is set in the environment", () => {
    const previous = process.env.NUTRIENT_VIEWER_ALLOWED_ROOTS;
    process.env.NUTRIENT_VIEWER_ALLOWED_ROOTS = workspace;
    try {
      // Env var is no longer respected; with no client roots, validation must still fail fast.
      expect(() => validatePathInAllowedRootsAtOpenTime(path.join(workspace, "doc.pdf"))).toThrow(
        /client has not advertised any filesystem roots/i
      );
    } finally {
      if (previous === undefined) delete process.env.NUTRIENT_VIEWER_ALLOWED_ROOTS;
      else process.env.NUTRIENT_VIEWER_ALLOWED_ROOTS = previous;
    }
  });
});

// 1B.L1: Assert that validatePathInAllowedRootsAtOpenTime is imported only from
// src/mcp/tools/open-document.ts. The symbol name encodes the open-time-only
// architectural constraint; any other tool importing it would bypass the design.
describe("validatePathInAllowedRootsAtOpenTime import scope", () => {
  it("is imported only from open-document.ts within src/mcp/tools/", () => {
    const toolsDir = path.resolve(import.meta.dirname ?? __dirname, "../../src/mcp/tools");
    const entries = fs.readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
    // Match only import statements, not comments or prose that mention the name.
    const importPattern = /^import[^;]*validatePathInAllowedRootsAtOpenTime/m;
    const importers: string[] = [];

    for (const entry of entries) {
      const content = fs.readFileSync(path.join(toolsDir, entry), "utf8");
      if (importPattern.test(content)) {
        importers.push(entry);
      }
    }

    expect(importers).toEqual(["open-document.ts"]);
  });

  it("is not imported from any file outside src/mcp/tools/open-document.ts in src/mcp/", () => {
    const mcpDir = path.resolve(import.meta.dirname ?? __dirname, "../../src/mcp");
    // Match only import statements, not comments, prose, or export declarations.
    // path-guard.ts itself is excluded — it's the definition site, not a consumer.
    const importPattern = /^import[^;]*validatePathInAllowedRootsAtOpenTime/m;

    const mcpLevelImporters = fs
      .readdirSync(mcpDir)
      .filter((f) => f.endsWith(".ts") && f !== "path-guard.ts")
      .filter((f) => importPattern.test(fs.readFileSync(path.join(mcpDir, f), "utf8")))
      .map((f) => `src/mcp/${f}`);

    const toolsLevelImporters = fs
      .readdirSync(path.join(mcpDir, "tools"))
      .filter((f) => f.endsWith(".ts") && f !== "open-document.ts")
      .filter((f) => importPattern.test(fs.readFileSync(path.join(mcpDir, "tools", f), "utf8")))
      .map((f) => `src/mcp/tools/${f}`);

    // No file outside path-guard.ts (the definition) should import this symbol,
    // other than the one permitted consumer: open-document.ts.
    expect(mcpLevelImporters).toEqual([]);
    expect(toolsLevelImporters).toEqual([]);
  });
});
