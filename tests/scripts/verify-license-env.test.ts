/**
 * Unit tests for `scripts/verify-license-env.mjs`.
 *
 * Drives the verifier's pure exports (`classify`, `readPlaceholder`,
 * `reportAndExit`) against synthetic inputs. The CLI block at the
 * bottom of the script is not exercised here — it only runs when the
 * script is invoked directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  classify,
  readPlaceholder,
  reportAndExit,
  VAR_NAME
  // @ts-expect-error - the verifier ships as .mjs without types
} from "../../scripts/verify-license-env.mjs";

type Result =
  | { kind: "unset" }
  | { kind: "placeholder"; placeholder: string }
  | { kind: "empty" }
  | { kind: "real" };

describe("verify-license-env", () => {
  describe("classify", () => {
    const PLACEHOLDER = "<YOUR_LICENSE_KEY_HERE>";

    it("returns unset when the env var is undefined", () => {
      expect(classify(undefined, PLACEHOLDER)).toEqual({ kind: "unset" });
    });

    it("returns placeholder when the value matches the .env.example placeholder", () => {
      expect(classify(PLACEHOLDER, PLACEHOLDER)).toEqual({
        kind: "placeholder",
        placeholder: PLACEHOLDER
      });
    });

    it("returns empty when the value is an empty string", () => {
      expect(classify("", PLACEHOLDER)).toEqual({ kind: "empty" });
    });

    it("returns real when the value is a non-empty real-looking key", () => {
      expect(classify("sk-live-abc123", PLACEHOLDER)).toEqual({ kind: "real" });
    });

    it("treats empty as empty even if the placeholder is also empty", () => {
      // Defensive: if .env.example is ever edited to a blank placeholder
      // (the pre-2026-05-08 state), an empty value should classify as
      // `empty` and trigger the trial-mode banner, not `placeholder`.
      // Otherwise the explicit-empty opt-out collapses into a hard fail.
      expect(classify("", "")).toEqual({ kind: "empty" });
    });

    it("treats real as real when placeholder is null (no .env.example)", () => {
      expect(classify("sk-live-abc123", null)).toEqual({ kind: "real" });
    });

    it("treats unset as unset when placeholder is null", () => {
      expect(classify(undefined, null)).toEqual({ kind: "unset" });
    });
  });

  describe("readPlaceholder", () => {
    let tmpDir: string;
    let envExample: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-license-env-"));
      envExample = path.join(tmpDir, ".env.example");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns the placeholder value verbatim", () => {
      fs.writeFileSync(envExample, "VITE_NUTRIENT_LICENSE_KEY=<YOUR_LICENSE_KEY_HERE>\n");
      expect(readPlaceholder(envExample)).toBe("<YOUR_LICENSE_KEY_HERE>");
    });

    it("strips surrounding double quotes from the placeholder", () => {
      fs.writeFileSync(envExample, 'VITE_NUTRIENT_LICENSE_KEY="<YOUR_LICENSE_KEY_HERE>"\n');
      expect(readPlaceholder(envExample)).toBe("<YOUR_LICENSE_KEY_HERE>");
    });

    it("strips surrounding single quotes from the placeholder", () => {
      fs.writeFileSync(envExample, "VITE_NUTRIENT_LICENSE_KEY='<YOUR_LICENSE_KEY_HERE>'\n");
      expect(readPlaceholder(envExample)).toBe("<YOUR_LICENSE_KEY_HERE>");
    });

    it("returns an empty string when the var is present but blank", () => {
      fs.writeFileSync(envExample, "VITE_NUTRIENT_LICENSE_KEY=\n");
      expect(readPlaceholder(envExample)).toBe("");
    });

    it("ignores comments and blank lines", () => {
      fs.writeFileSync(
        envExample,
        "# Some comment\n\n# Another\nVITE_NUTRIENT_LICENSE_KEY=<YOUR_LICENSE_KEY_HERE>\n"
      );
      expect(readPlaceholder(envExample)).toBe("<YOUR_LICENSE_KEY_HERE>");
    });

    it("returns null when the var is absent", () => {
      fs.writeFileSync(envExample, "OTHER_VAR=something\n");
      expect(readPlaceholder(envExample)).toBe(null);
    });

    it("returns null when the .env.example file does not exist", () => {
      expect(readPlaceholder(path.join(tmpDir, "missing.env.example"))).toBe(null);
    });

    it("does not match a key with a different prefix", () => {
      fs.writeFileSync(envExample, "FOO_VITE_NUTRIENT_LICENSE_KEY=other\n");
      expect(readPlaceholder(envExample)).toBe(null);
    });
  });

  describe("reportAndExit", () => {
    function captureExit(result: Result): {
      exitCode: number | undefined;
      logs: string[];
      warns: string[];
      errors: string[];
    } {
      let exitCode: number | undefined;
      const logs: string[] = [];
      const warns: string[] = [];
      const errors: string[] = [];
      const exit = ((code?: number) => {
        exitCode = code;
        return undefined as never;
      }) as typeof process.exit;
      reportAndExit(result, {
        exit,
        log: (msg: string) => logs.push(msg),
        warn: (msg: string) => warns.push(msg),
        error: (msg: string) => errors.push(msg)
      });
      return { exitCode, logs, warns, errors };
    }

    it("exits 1 with a configuration message on unset", () => {
      const { exitCode, errors } = captureExit({ kind: "unset" });
      expect(exitCode).toBe(1);
      expect(errors.some((m) => m.includes(VAR_NAME) && m.includes("not set"))).toBe(true);
    });

    it("exits 1 with a template-not-edited message on placeholder", () => {
      const { exitCode, errors } = captureExit({
        kind: "placeholder",
        placeholder: "<YOUR_LICENSE_KEY_HERE>"
      });
      expect(exitCode).toBe(1);
      expect(errors.some((m) => m.includes("matches the .env.example placeholder"))).toBe(true);
    });

    it("exits 0 on empty (trial mode) after printing a banner", () => {
      const { exitCode, warns, errors } = captureExit({ kind: "empty" });
      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(warns.some((m) => m.includes("TRIAL MODE BUILD"))).toBe(true);
      expect(warns.some((m) => m.includes("watermark"))).toBe(true);
    });

    it("exits 0 silently on real (production)", () => {
      const { exitCode, logs, warns, errors } = captureExit({ kind: "real" });
      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(warns).toEqual([]);
      expect(logs.some((m) => m.includes(VAR_NAME) && m.includes("production build"))).toBe(true);
    });
  });
});
