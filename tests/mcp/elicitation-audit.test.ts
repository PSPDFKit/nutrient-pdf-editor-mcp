/**
 * AC9.2: Elicitation audit — verify only apply-annotations.ts uses elicitation
 * This is a static structural test that greps the tools directory.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(__dirname, "../../src/mcp/tools");

describe("elicitation audit (AC9.2)", () => {
  it("only apply-annotations.ts calls elicit", () => {
    // Read all tool files
    const files = fs
      .readdirSync(toolsDir)
      .filter((f) => f.endsWith(".ts") && !f.startsWith("."));

    // Check each file for elicit patterns
    const elicitMatches = files.filter((f) => {
      const content = fs.readFileSync(path.join(toolsDir, f), "utf-8");
      // Match patterns like: .elicit(, .elicitInput(, server.elicit
      return /\.elicit(Input)?\s*\(/.test(content) || /server\.elicit/.test(content);
    });

    // Only apply-annotations.ts should match
    expect(elicitMatches).toEqual(["apply-annotations.ts"]);
  });
});
