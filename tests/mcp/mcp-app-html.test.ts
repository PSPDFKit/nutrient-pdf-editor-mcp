/**
 * 3A.L-3: Smoke test that the built dist/mcp-app.html has the expected
 * structural markers so Vite transformation drift (missing inlines, wrong
 * title, lost #viewer mount-point) surfaces as a clear unit failure
 * without requiring a full Playwright browser run.
 *
 * The test skips automatically when dist/mcp-app.html is absent (i.e. in a
 * pre-build CI stage that runs unit tests before the build step). Run
 * `npm run build` once to enable it locally.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const distHtmlPath = path.join(projectRoot, "dist/mcp-app.html");

const BUILT = fs.existsSync(distHtmlPath);

describe.skipIf(!BUILT)(
  "dist/mcp-app.html structure (3A.L-3 — Vite drift guard)",
  () => {
    let html: string;

    // Load once; all assertions share the same string.
    it("dist/mcp-app.html exists", () => {
      expect(fs.existsSync(distHtmlPath)).toBe(true);
      html = fs.readFileSync(distHtmlPath, "utf-8");
    });

    it("is a valid HTML document with the expected title", () => {
      if (!html) html = fs.readFileSync(distHtmlPath, "utf-8");
      expect(html).toContain("<!doctype html>");
      expect(html.toLowerCase()).toContain("<title>");
      // The src/viewer/index.html title is "Nutrient Viewer MCP". Vite
      // should carry this through untouched.
      expect(html).toContain("Nutrient Viewer MCP");
    });

    it("has the #viewer mount-point div", () => {
      if (!html) html = fs.readFileSync(distHtmlPath, "utf-8");
      // Vite singlefile inlines everything; the #viewer div must survive.
      expect(html).toMatch(/id\s*=\s*["']viewer["']/);
    });

    it("has inlined JavaScript (no external script src pointing to ./main.ts)", () => {
      if (!html) html = fs.readFileSync(distHtmlPath, "utf-8");
      // The source HTML references `./main.ts` which Vite transforms to an
      // inline <script> in the built output (vite-plugin-singlefile). If
      // the transform regresses, the raw TS path leaks through.
      expect(html).not.toContain("./main.ts");
      // There must be at least one non-trivial inline script block.
      expect(html).toMatch(/<script[^>]*>/);
    });

    it("exposes the __app global initialisation token", () => {
      if (!html) html = fs.readFileSync(distHtmlPath, "utf-8");
      // main.ts assigns `window.__app = app` so the harness / host can
      // reach the viewer. If Vite tree-shakes or renames it, tests break.
      expect(html).toContain("__app");
    });
  }
);
