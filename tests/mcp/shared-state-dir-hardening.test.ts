import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSharedFileBackend } from "../../src/mcp/shared-state/file-backend.js";

/**
 * SR-003: shared-state staging directory hardening.
 *
 * The backend must:
 *   - create the dir with mode 0o700 (umask-independent),
 *   - tighten a pre-existing dir we own to 0o700 in place (migration from
 *     before SR-003 landed; threat model is "attacker pre-created", and an
 *     attacker can't have done that as us — uid is the real check),
 *   - reject a symlink at the staging path (lstat-based check, not stat),
 *   - reject a non-directory at the staging path,
 *   - succeed on a clean first-time run and produce a 0o700 dir.
 *
 * We isolate every test under a per-test mkdtempSync sandbox so the real
 * `${TMPDIR}/nutrient-pdf-editor/` is never touched.
 */
describe("shared-state dir hardening (SR-003)", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "shared-state-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("first-time creation succeeds and dir has mode 0o700", () => {
    const stateDir = path.join(sandbox, "nutrient-pdf-editor");
    expect(fs.existsSync(stateDir)).toBe(false);

    createSharedFileBackend({ stateDir });

    const stat = fs.lstatSync(stateDir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
    expect(stat.uid).toBe(process.getuid?.());
  });

  it("tightens a pre-existing dir from 0o755 to 0o700 in place", () => {
    // Migration scenario: a previous version of the server ran with the
    // default umask and left ${TMPDIR}/nutrient-pdf-editor at 0o755. The
    // dir is owned by us. The new SR-003 check should chmod it down to
    // 0o700 rather than refuse to start.
    const stateDir = path.join(sandbox, "nutrient-pdf-editor");
    fs.mkdirSync(stateDir, { mode: 0o755 });
    fs.chmodSync(stateDir, 0o755);
    expect(fs.lstatSync(stateDir).mode & 0o777).toBe(0o755);

    expect(() => createSharedFileBackend({ stateDir })).not.toThrow();
    expect(fs.lstatSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing dir from 0o777 to 0o700 in place", () => {
    const stateDir = path.join(sandbox, "nutrient-pdf-editor");
    fs.mkdirSync(stateDir, { mode: 0o777 });
    fs.chmodSync(stateDir, 0o777);

    expect(() => createSharedFileBackend({ stateDir })).not.toThrow();
    expect(fs.lstatSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it("rejects a non-directory file at the staging path", () => {
    // Node's `mkdirSync(path, {recursive: true})` throws EEXIST when a
    // regular file already exists at the path, before our lstat check
    // would fire. Either way the path is refused — the test asserts
    // refusal, not a specific error shape.
    const stateDir = path.join(sandbox, "nutrient-pdf-editor");
    fs.writeFileSync(stateDir, "not a dir");

    expect(() => createSharedFileBackend({ stateDir })).toThrow(
      /EEXIST|unexpected ownership/,
    );
  });

  it("rejects a symlink planted at the staging path", () => {
    const realTarget = path.join(sandbox, "attacker-target");
    fs.mkdirSync(realTarget, { mode: 0o700 });
    const stateDir = path.join(sandbox, "nutrient-pdf-editor");
    fs.symlinkSync(realTarget, stateDir);

    // Sanity: the symlink resolves to a real dir, but lstat sees the link
    // itself — that's the whole point of using lstatSync in the backend.
    expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(true);
    expect(fs.statSync(stateDir).isDirectory()).toBe(true);

    expect(() => createSharedFileBackend({ stateDir })).toThrow(
      /unexpected ownership/,
    );
  });

  it("two consecutive constructions on a clean stateDir both succeed", () => {
    // Once the first call has created the dir at 0o700, the second call's
    // mkdirSync({recursive:true}) is a no-op and the lstat check still passes.
    // Regression guard: don't accidentally tighten the check to "must be
    // freshly created".
    const stateDir = path.join(sandbox, "nutrient-pdf-editor");
    createSharedFileBackend({ stateDir });
    expect(() => createSharedFileBackend({ stateDir })).not.toThrow();
    expect(fs.lstatSync(stateDir).mode & 0o777).toBe(0o700);
  });
});
